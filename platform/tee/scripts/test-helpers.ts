// Shared helpers for the example tests (`examples/*/*.test.ts`).
//
// Each test file calls `setupApplet("<name>")` once in `beforeAll` and then
// uses `callApplet(method, input)` to drive the bridge. `setupApplet` is
// the slow step: it rebuilds the Rust applet from examples/<name>/main.rs,
// uploads it, and waits for QEMU to come back after the auto-restart.
//
// All addresses default to 127.0.0.1:4000 (the QEMU container's published
// port). Override with DEVICE_HOST/DEVICE_PORT to talk to real USB Armory
// MK II hardware at 10.0.0.1:4000 (see docs/PORTING_TO_USBARMORY.md).

import { $ } from 'bun';

const DEVICE_HOST = Bun.env.DEVICE_HOST ?? '127.0.0.1';
const DEVICE_PORT = Number(Bun.env.DEVICE_PORT ?? 4000);
const REPO_ROOT = new URL('../', import.meta.url).pathname;

type Example = 'square' | 'crypto' | 'attestation';

// Single TCP round-trip to the bridge via nc. Shells out per call because
// Bun's native TCP APIs (Bun.connect, node:net) get process-wedged after
// the bridge link cycles on a hot-swap reboot — the workaround was found
// on hardware (USB-CDC-ECM) but applies to QEMU too.
export async function callApplet(
  method: string,
  input: string,
  timeoutSec = 3,
): Promise<string> {
  const req = JSON.stringify({ Method: method, Input: input }) + '\n';
  const proc = Bun.spawn(
    ['nc', '-w', String(timeoutSec), DEVICE_HOST, String(DEVICE_PORT)],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );
  proc.stdin.write(req);
  await proc.stdin.end();

  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exit !== 0 || !stdout) {
    throw new Error(stderr.trim() || `nc exited ${exit}`);
  }

  const nl = stdout.indexOf('\n');
  const reply = JSON.parse(nl >= 0 ? stdout.slice(0, nl) : stdout);
  if (reply.Error) throw new Error(reply.Error);
  return reply.Output ?? '';
}

// Poll the bridge until it answers. Uses an arbitrary method name — the
// Trusted OS forwards unknown methods to the applet, which replies with
// an empty string, so any reply (even empty) means "device alive".
export async function waitForDevice(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await callApplet('__probe', '', 2);
      return;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(500);
    }
  }
  throw new Error(
    `device did not answer on ${DEVICE_HOST}:${DEVICE_PORT} within ${timeoutMs} ms (last: ${(lastErr as Error)?.message})`,
  );
}

// Build the Rust applet on the host (cargo via root Makefile → docker/Makefile).
async function makeApplet(): Promise<void> {
  const proc = Bun.spawn(['make', 'applet'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    throw new Error(`make applet failed:\n${stdout}\n${stderr}`);
  }
}

// Upload the built applet ELF. Expected reply is "ok, rebooting", but the
// Trusted OS's os.Exit can race past nc's read — empty stdout with exit 0
// is still a probable success. waitForDevice is the real proof.
async function uploadApplet(): Promise<string> {
  const proc = Bun.spawn(
    ['bun', 'run', 'scripts/upload.ts', 'target/armv7a-none-eabi/release/trusted_applet'],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    throw new Error(`upload failed:\n${stdout}\n${stderr}`);
  }
  return stdout.trim();
}

// One-shot: copy an example over src/main.rs, rebuild, upload, wait for
// the QEMU auto-restart wrapper to bring the bridge back. Logs each step
// so failures show which phase is slow.
export async function setupApplet(name: Example): Promise<void> {
  const t0 = Date.now();
  const step = (msg: string) =>
    console.log(`[${name}] +${((Date.now() - t0) / 1000).toFixed(1)}s ${msg}`);

  step('cp examples/' + name + '/main.rs → src/main.rs');
  await $`cp examples/${name}/main.rs src/main.rs`.cwd(REPO_ROOT).quiet();

  step('make applet');
  await makeApplet();

  step('upload');
  await uploadApplet();

  // QEMU cold-boot under TCG is slower than a real device; allow up to
  // 60 s in waitForDevice (above) but give the wrapper restart a head
  // start before we begin polling.
  step('wait 3 s for QEMU restart');
  await Bun.sleep(3000);

  step('waitForDevice');
  await waitForDevice();

  step('ready');
}

// Sanity-check the environment before touching the device. Fails loudly
// if the bridge isn't reachable so participants get one actionable error
// instead of dozens of cryptic timeouts.
export async function preflight(): Promise<void> {
  try {
    await callApplet('__probe', '', 2);
  } catch (e) {
    throw new Error(
      `Bridge not reachable at ${DEVICE_HOST}:${DEVICE_PORT}. ` +
        `Did you start the emulator with 'make qemu' (in another shell)? ` +
        `(last error: ${(e as Error).message})`,
    );
  }
}
