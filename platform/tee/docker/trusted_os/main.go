// GoTEE Trusted OS for QEMU emulation of the i.MX6ULL EVK.
//
// This is the QEMU-only edition of the GoTEE Rust Starter. The Trusted OS
// runs in Secure World system mode under TamaGo, supervises the Rust
// Trusted Applet, and exposes a JSON/TCP bridge plus an SSH listener over
// the FEC ENET interface that QEMU emulates.
//
// For the equivalent code on real USB Armory MK II hardware (USB-CDC-ECM
// transport, watchdog reset, on-chip crypto, SD-card-backed applet
// persistence), see docs/PORTING_TO_USBARMORY.md.
//
// Users should NOT need to modify this file. Edit src/main.rs instead.

package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	_ "embed"
	"fmt"
	"log"
	"net"
	"os"
	"runtime"
	"sync"
	_ "unsafe"

	"github.com/usbarmory/tamago/board/nxp/mx6ullevk"
	"github.com/usbarmory/tamago/dma"
	"github.com/usbarmory/tamago/soc/nxp/enet"
	"github.com/usbarmory/tamago/soc/nxp/imx6ul"

	gnet "github.com/usbarmory/go-net"

	"golang.org/x/crypto/ssh"
	"golang.org/x/term"
)

// Embed the Rust Trusted Applet ELF built by Cargo.
// The Makefile copies the built binary here before compiling the Trusted OS.
//
//go:embed assets/trusted_applet.elf
var taELF []byte

//go:linkname ramStart runtime/goos.RamStart
var ramStart uint32 = SecureStart

//go:linkname ramSize runtime/goos.RamSize
var ramSize uint32 = SecureSize

const (
	sshPort = 22
	ip      = "10.0.0.1"
	cidr    = ip + "/24"
	mac     = "1a:55:89:a2:69:41"
	gateway = "10.0.0.2"
)

// appletSwapCh receives a new applet ELF when the bridge's __upload path
// wants to hot-swap. The supervisor goroutine reads it, terminates the
// running applet, and loads the replacement. depth 1 so an upload that
// arrives while the previous swap is in flight is preserved (the older
// pending swap is discarded — last-write-wins is fine for this use case).
var appletSwapCh = make(chan []byte, 1)

func init() {
	log.SetFlags(log.Ltime)
	log.SetOutput(os.Stdout)

	initMemory()
	dma.Init(SecureDMAStart, SecureDMASize)

	// On real hardware imx6ul.Family selects between IMX6UL (CAAM, BEE)
	// and IMX6ULL (DCP). Under QEMU mcimx6ul-evk, imx6ul.Native is false
	// and we skip all the on-chip crypto init — none of those engines are
	// emulated and probing them would hang the boot. SetARMFreq is fine
	// either way.
	if imx6ul.Native {
		switch imx6ul.Family {
		case imx6ul.IMX6UL:
			imx6ul.SetARMFreq(imx6ul.Freq528)
		case imx6ul.IMX6ULL:
			imx6ul.SetARMFreq(imx6ul.FreqMax)
		}
	}
}

func main() {
	log.Printf("%s/%s (%s) • GoTEE Trusted OS — QEMU edition (Secure World)",
		runtime.GOOS, runtime.GOARCH, runtime.Version())

	// Note: TZASC + CSU restrictions (tz.go) are intentionally NOT called
	// here. This starter runs a Trusted Applet in Secure user mode with
	// no Normal-World OS — there is no second world to isolate against.
	go superviseApplet()

	startNetworking()
}

// superviseApplet runs the applet in a loop, swapping to a new ELF when
// one arrives via appletSwapCh. The first iteration runs the embedded
// default; subsequent iterations run whatever the host last uploaded.
//
// This replaces the hardware path's "write to SD + WDOG reset + reboot"
// flow. SD persistence isn't usable under QEMU's mcimx6ul-evk because
// the emulated USDHC controller doesn't clear its software-reset bit
// (a known QEMU limitation), so we keep the live ELF in memory only.
// Each `make qemu` starts fresh with the embedded default; uploads
// persist for the lifetime of the QEMU container.
func superviseApplet() {
	elf := taELF

	for {
		log.Printf("SM loading applet (%d bytes)", len(elf))
		ta, err := loadApplet(elf)
		if err != nil {
			log.Fatalf("SM failed to load applet: %v", err)
		}

		var wg sync.WaitGroup
		wg.Add(1)
		go runApplet(ta, &wg)

		select {
		case newELF := <-appletSwapCh:
			log.Printf("SM hot-swap requested, terminating current applet")
			// Push __exit to the applet's RPC channel; the applet's
			// serve() loop sees it and calls SYS_EXIT, which causes
			// runApplet's ctx.Run() to return. Non-blocking send: if
			// the applet was idle (long-poll on Recv) the slot is
			// empty; if it was processing a call there'll already be
			// a request in flight and we'll let it finish before our
			// __exit is delivered.
			select {
			case appletRequestCh <- AppletCall{Method: "__exit"}:
			default:
				// channel full — applet will pick up __exit after
				// its current call returns
				appletRequestCh <- AppletCall{Method: "__exit"}
			}
			wg.Wait()
			elf = newELF
		}
	}
}

// fecAdapter implements gnet.NetworkDevice for the i.MX6 FEC ENET driver.
// The underlying enet.ENET driver exposes raw Rx()/Tx() rather than the
// (n int, err error) shape gnet expects, so we adapt here.
type fecAdapter struct {
	eth *enet.ENET
}

func (a *fecAdapter) Receive(buf []byte) (int, error) {
	frame := a.eth.Rx()
	if frame == nil {
		return 0, nil
	}
	return copy(buf, frame), nil
}

func (a *fecAdapter) Transmit(buf []byte) error {
	a.eth.Tx(buf)
	return nil
}

// startNetworking brings up FEC ENET inside the QEMU guest, hooks the gVisor
// stack into Go's runtime networking, and starts the bridge + SSH listeners.
//
// The QEMU-emulated mcimx6ul-evk machine wires its `imx.enet` NIC to ENET1.
// imx6ul.Native is false under QEMU, which selects ENET1 here (matching the
// tamago-example pattern). On a hypothetical real EVK we would use ENET2.
func startNetworking() {
	eth := imx6ul.ENET1
	if imx6ul.Native {
		eth = imx6ul.ENET2
	}

	hwAddr, err := net.ParseMAC(mac)
	if err != nil {
		log.Fatalf("SM bad MAC: %v", err)
	}

	eth.Init()
	eth.SetMAC(hwAddr)

	iface := &gnet.Interface{NetworkDevice: &fecAdapter{eth: eth}}
	if err := iface.Init(cidr, mac, gateway); err != nil {
		log.Fatalf("SM could not initialize network stack: %v", err)
	}
	iface.HandleStackErr = func(err error, tx bool) {
		log.Printf("SM stack error (tx=%v): %v", tx, err)
	}
	if err := iface.Stack.EnableICMP(); err != nil {
		log.Fatalf("SM could not enable ICMP: %v", err)
	}

	// Hook the gVisor stack into Go's net package. After this, standard
	// net.Listen / net.Dial work and route through the emulated NIC.
	net.SocketFunc = iface.Stack.Socket

	bridgeListener, err := net.Listen("tcp4", fmt.Sprintf(":%d", bridgePort))
	if err != nil {
		log.Fatalf("SM could not create bridge listener: %v", err)
	}
	go startBridge(bridgeListener)

	sshListener, err := net.Listen("tcp4", fmt.Sprintf(":%d", sshPort))
	if err != nil {
		log.Fatalf("SM could not create SSH listener: %v", err)
	}
	go startSSH(sshListener)

	eth.Start(true)

	// Drive the gnet Interface in a goroutine: it polls Receive() and
	// hands frames to the gVisor stack. Avoiding the interrupt-driven
	// path keeps us off the GIC and out of the GoTEE monitor's exception
	// vector — simpler and proven against tamago-example.
	go iface.Start()

	// Block forever. main() returning would unwind everything.
	select {}
}

func mustECDSAKey() ssh.Signer {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatalf("SM SSH key generation failed: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		log.Fatalf("SM SSH signer creation failed: %v", err)
	}
	return signer
}

func startSSH(listener net.Listener) {
	srv := &ssh.ServerConfig{NoClientAuth: true}
	signer := mustECDSAKey()
	log.Printf("SM SSH server started (%s)", ssh.FingerprintSHA256(signer.PublicKey()))
	srv.AddHostKey(signer)

	for {
		conn, err := listener.Accept()
		if err != nil {
			continue
		}

		sshConn, chans, reqs, err := ssh.NewServerConn(conn, srv)
		if err != nil {
			continue
		}

		log.Printf("SM new SSH connection from %s", sshConn.RemoteAddr())
		go ssh.DiscardRequests(reqs)
		go handleSSHChannels(chans)
	}
}

func handleSSHChannels(chans <-chan ssh.NewChannel) {
	for ch := range chans {
		if ch.ChannelType() != "session" {
			ch.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}

		conn, reqs, err := ch.Accept()
		if err != nil {
			continue
		}

		terminal := term.NewTerminal(conn, "> ")

		go func() {
			defer conn.Close()
			for {
				line, err := terminal.ReadLine()
				if err != nil {
					return
				}
				fmt.Fprintf(terminal, "echo: %s\r\n", line)
			}
		}()

		go func() {
			for req := range reqs {
				if req.Type == "shell" && len(req.Payload) == 0 {
					req.Reply(true, nil)
				}
			}
		}()
	}
}

// Touch mx6ullevk so its package init() runs (USDHC pinmux + console).
var _ = mx6ullevk.SD1
