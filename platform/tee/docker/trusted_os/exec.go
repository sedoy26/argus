// Applet loading and execution.
//
// Loads the embedded Rust Trusted Applet ELF, configures memory and MMU,
// and runs it in Secure World user mode under the GoTEE monitor.

package main

import (
	"fmt"
	"log"
	"sync"

	"github.com/usbarmory/tamago/arm"
	"github.com/usbarmory/tamago/dma"
	"github.com/usbarmory/tamago/soc/nxp/imx6ul"

	"github.com/usbarmory/GoTEE/monitor"

	"github.com/usbarmory/armory-boot/exec"
)

func configureMMU(region *dma.Region, alias uint32) {
	start := uint32(region.Start())
	end := uint32(region.End())
	imx6ul.ARM.ConfigureMMU(start, end, alias, arm.MemoryRegion|arm.TTE_AP_011<<10)
}

func loadApplet(taELF []byte) (*monitor.ExecCtx, error) {
	image := &exec.ELFImage{
		Region: AppletRegion,
		ELF:    taELF,
	}

	alias := uint32(AppletPhysicalStart)

	// Enable BEE encryption if available and configured
	if imx6ul.Native && imx6ul.BEE != nil && UseBEE {
		log.Printf("SM loading applet in BEE encrypted memory")
		alias = 0
	}

	configureMMU(image.Region, alias)

	if err := image.Load(); err != nil {
		return nil, fmt.Errorf("SM could not load applet ELF: %v", err)
	}

	ta, err := monitor.Load(image.Entry(), image.Region, true)
	if err != nil {
		return nil, fmt.Errorf("SM could not load applet into monitor: %v", err)
	}

	log.Printf("SM loaded applet addr:%#x entry:%#x size:%d", ta.Memory.Start(), ta.R15, len(taELF))

	// Register RPC services available to the applet
	ta.Server.Register(&RPC{})

	// Set stack pointer to end of applet region
	ta.R13 = uint32(ta.Memory.End())

	// Set exception handler
	ta.Handler = appletHandler

	return ta, nil
}

func runApplet(ctx *monitor.ExecCtx, wg *sync.WaitGroup) {
	mode := arm.ModeName(int(ctx.SPSR) & 0x1f)
	ns := ctx.NonSecure()

	log.Printf("SM starting applet mode:%s sp:%#.8x pc:%#.8x ns:%v", mode, ctx.R13, ctx.R15, ns)

	err := ctx.Run()

	if wg != nil {
		wg.Done()
	}

	log.Printf("SM applet stopped mode:%s sp:%#.8x pc:%#.8x ns:%v err:%v", mode, ctx.R13, ctx.R15, ns, err)
}
