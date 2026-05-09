// TCP bridge between a host caller and the Trusted Applet.
//
// One request per connection. The host opens a TCP connection, writes a
// single {"Method","Input"} JSON line, reads one {"Output"|"Error"} line,
// and the server closes. This is the only entry point Normal World
// callers have into the applet — CallApplet is what actually drives the
// dispatch loop in rpc.go.
//
// Method "__upload" is intercepted here to receive a new applet ELF over
// the wire. On real USB Armory hardware that path persists the ELF to SD
// and triggers a watchdog reset. Under QEMU we hot-swap the running
// applet in-process via appletSwapCh — the supervisor in main.go ends
// the current applet and loads the new one without exiting the guest.

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net"
)

const bridgePort = 4000

type bridgeRequest struct {
	Method string
	Input  string
}

type bridgeReply struct {
	Output string
	Error  string `json:",omitempty"`
}

func startBridge(l net.Listener) {
	log.Printf("SM bridge listening on :%d", bridgePort)

	for {
		conn, err := l.Accept()
		if err != nil {
			continue
		}
		go handleBridgeConn(conn)
	}
}

// validateAppletELF performs the same minimal structural sanity checks
// the hardware path used to do before persisting the upload to SD.
// A bad ELF here panics the new-applet load anyway, but rejecting at
// the bridge keeps the error close to the user.
func validateAppletELF(elf []byte) error {
	if len(elf) < 52 {
		return errors.New("applet: too small to be ELF")
	}
	if !bytes.Equal(elf[:4], []byte{0x7f, 'E', 'L', 'F'}) {
		return errors.New("applet: missing ELF magic")
	}
	if elf[4] != 1 {
		return errors.New("applet: not ELFCLASS32")
	}
	if elf[18] != 0x28 {
		return errors.New("applet: not EM_ARM")
	}
	return nil
}

// One request per connection: read a single {"Method","Input"}, write
// one {"Output"|"Error"} reply, close. Closing after the reply means
// `printf … | nc 127.0.0.1 4000` exits cleanly on every nc variant
// (BSD on macOS, openbsd-netcat on Linux) without needing -q/-N flags.
func handleBridgeConn(conn net.Conn) {
	defer conn.Close()

	dec := json.NewDecoder(conn)
	enc := json.NewEncoder(conn)

	var req bridgeRequest
	if err := dec.Decode(&req); err != nil {
		return
	}

	switch req.Method {
	case "__upload":
		elf, err := base64.StdEncoding.DecodeString(req.Input)
		if err != nil {
			enc.Encode(bridgeReply{Error: "base64: " + err.Error()})
			return
		}
		if err := validateAppletELF(elf); err != nil {
			enc.Encode(bridgeReply{Error: err.Error()})
			return
		}
		// Reply BEFORE pushing to the swap channel. The supervisor will
		// terminate the current applet imminently and the bridge stays
		// up across the swap, but replying first keeps "ok, swapping"
		// out of any race with the applet teardown.
		enc.Encode(bridgeReply{Output: "ok, swapping"})
		conn.Close()
		log.Print("SM applet upload accepted, hot-swapping")
		appletSwapCh <- elf
	default:
		enc.Encode(bridgeReply{Output: CallApplet(req.Method, req.Input)})
	}
}
