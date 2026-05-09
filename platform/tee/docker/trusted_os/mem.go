// Memory layout constants for ARM TrustZone on USB Armory MK II.
//
// These match the GoTEE-example mem/layout_arm.go definitions.

package main

import (
	"github.com/usbarmory/tamago/dma"
	"github.com/usbarmory/tamago/soc/nxp/bee"
)

const (
	// Secure Monitor (Trusted OS)
	SecureStart    = 0x90000000
	SecureSize     = 0x05f00000 // 95 MB
	SecureDMAStart = 0x95f00000
	SecureDMASize  = 0x00100000 // 1 MB

	// Trusted Applet (virtual, via BEE alias)
	AppletVirtualStart  = bee.AliasRegion0 // 0x10000000
	AppletSize          = 0x02000000       // 32 MB
	AppletPhysicalStart = 0x96000000
	AppletShadowStart   = 0x98000000

	// Normal World (Non-Secure)
	NonSecureStart = 0x80000000
	NonSecureSize  = 0x10000000 // 256 MB

	// BEE AES encryption for applet RAM on i.MX6UL
	UseBEE = true
)

var (
	AppletRegion    *dma.Region
	NonSecureRegion *dma.Region
)

func initMemory() {
	AppletRegion, _ = dma.NewRegion(AppletVirtualStart, AppletSize, false)
	AppletRegion.Reserve(AppletSize, 0)

	NonSecureRegion, _ = dma.NewRegion(NonSecureStart, NonSecureSize, false)
	NonSecureRegion.Reserve(NonSecureSize, 0)
}
