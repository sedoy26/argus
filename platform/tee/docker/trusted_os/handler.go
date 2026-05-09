// Syscall and exception handler for the Trusted OS.
//
// Handles syscalls from both the Trusted Applet (Secure World user mode)
// and the Normal World OS via ARM SVC/SMC instructions.

package main

import (
	"errors"
	"fmt"
	"log"

	"github.com/usbarmory/tamago/arm"

	"github.com/usbarmory/GoTEE/monitor"
	"github.com/usbarmory/GoTEE/syscall"
)

// appletHandler handles exceptions from the Trusted Applet and Normal World.
func appletHandler(ctx *monitor.ExecCtx) error {
	// Handle data aborts from the Normal World
	if ctx.ExceptionVector == arm.DATA_ABORT && ctx.NonSecure() {
		log.Printf("SM trapped Non-secure data abort pc:%#.8x", ctx.R15-8)
		log.Print(ctx)
		ctx.Stop()
		return nil
	}

	if ctx.ExceptionVector != arm.SUPERVISOR {
		return fmt.Errorf("unexpected exception %x", ctx.ExceptionVector)
	}

	switch ctx.A0() {
	case syscall.SYS_WRITE:
		// Write a single byte to the console
		b := byte(ctx.A1())
		bufferedLog(b, !ctx.NonSecure())
	case syscall.SYS_EXIT:
		ctx.Stop()
	default:
		if ctx.NonSecure() {
			log.Print(ctx)
			return errors.New("unexpected monitor call from Normal World")
		}
		// Delegate other Secure World syscalls to default handler
		return monitor.SecureHandler(ctx)
	}

	return nil
}

// logBuf accumulates bytes until a newline for cleaner log output.
var (
	secureBuf    []byte
	nonsecureBuf []byte
)

func bufferedLog(b byte, secure bool) {
	var prefix string
	var buf *[]byte

	if secure {
		prefix = "TA"
		buf = &secureBuf
	} else {
		prefix = "OS"
		buf = &nonsecureBuf
	}

	*buf = append(*buf, b)

	if b == '\n' || b == '\r' {
		if len(*buf) > 1 {
			log.Printf("%s %s", prefix, string(*buf))
		}
		*buf = nil
	}
}
