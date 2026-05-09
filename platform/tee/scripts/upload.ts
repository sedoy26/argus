// One-shot CLI uploader — pushes a new Trusted Applet ELF to the device
// over the bridge. Under QEMU the Trusted OS hot-swaps the running
// applet in-process; on hardware (see docs/PORTING_TO_USBARMORY.md) it
// persists the ELF to SD and triggers a watchdog reset.
//
// `bun run upload` (no args) uses the standard cargo output path defined
// in package.json:
//   bun run upload
// Override by passing an explicit path:
//   bun run scripts/upload.ts path/to/other.elf
//
// The bridge endpoint defaults to 127.0.0.1:4000 (the QEMU container's
// published port). Override with DEVICE_HOST / DEVICE_PORT to talk to a
// real USB Armory MK II at 10.0.0.1:4000 instead.

const path = Bun.argv[2];
if (!path) {
  console.error('usage: upload.ts <path/to/trusted_applet.elf>');
  process.exit(2);
}

const DEVICE_HOST = Bun.env.DEVICE_HOST ?? '127.0.0.1';
const DEVICE_PORT = Number(Bun.env.DEVICE_PORT ?? 4000);

const elf = await Bun.file(path).bytes();
const payload =
  JSON.stringify({
    Method: '__upload',
    Input: Buffer.from(elf).toString('base64'),
  }) + '\n';

const proc = Bun.spawn(['nc', '-w', '10', DEVICE_HOST, String(DEVICE_PORT)], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
});
proc.stdin.write(payload);
await proc.stdin.end();

const [stdout, stderr, exit] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);

// Expected reply is "ok, rebooting". The Trusted OS's os.Exit can race
// past nc's read, so we often see no reply even though the upload landed.
// BSD nc (macOS) exits 0 in that case; openbsd-netcat (Linux) exits 1.
// Treat both as probable success and only fail loud on real TCP-level
// errors (connect refused / host unreachable / no route).
const connFailed = /refused|unreachable|no route|name or service/i.test(stderr);
if (connFailed) {
  console.error('upload failed:', stderr.trim());
  process.exit(1);
}

const reply = stdout.trim();
if (reply) {
  console.log(reply);
} else {
  console.log(`ok, probably rebooting (no reply captured; nc exited ${exit})`);
  console.log('  verify in ~5s once QEMU has restarted:');
  console.log(`    printf '{"Method":"__probe","Input":""}\\n' | nc -w 2 ${DEVICE_HOST} ${DEVICE_PORT}`);
  console.log('  any reply (even {"Output":""}) means the device is back up.');
}
