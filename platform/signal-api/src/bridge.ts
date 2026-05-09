// TCP/JSON bridge client for the GoTEE Trusted OS.
//
// We shell out to `nc` per call rather than using Bun.connect / node:net.
// The starter's test-helpers.ts documents why: native TCP APIs wedge
// after the bridge link cycles on a hot-swap reboot. `nc -w <timeout>`
// is the workaround that survives reboots cleanly.
//
// Bridge protocol (see platform/tee/CLAUDE.md → "Bridge protocol"):
//   → {"Method":"<name>","Input":"<utf-8>"}\n
//   ← {"Output":"<utf-8>"}\n
//   ← {"Error":"<message>"}\n

const DEVICE_HOST = Bun.env.DEVICE_HOST ?? '127.0.0.1';
const DEVICE_PORT = Number(Bun.env.DEVICE_PORT ?? 4000);

export class BridgeError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'BridgeError';
  }
}

export async function callApplet(
  method: string,
  input: string,
  timeoutSec = 5,
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

  if (exit !== 0 && !stdout) {
    throw new BridgeError(
      stderr.trim() || `nc exited ${exit} with no output`,
    );
  }
  if (!stdout.trim()) {
    throw new BridgeError('empty reply from bridge');
  }

  const nl = stdout.indexOf('\n');
  const line = nl >= 0 ? stdout.slice(0, nl) : stdout;
  let reply: { Output?: string; Error?: string };
  try {
    reply = JSON.parse(line);
  } catch (e) {
    throw new BridgeError(`bridge returned non-JSON: ${line}`, e);
  }
  if (reply.Error) {
    throw new BridgeError(`bridge error: ${reply.Error}`);
  }
  return reply.Output ?? '';
}

export async function ping(timeoutSec = 2): Promise<boolean> {
  try {
    await callApplet('__probe', '', timeoutSec);
    return true;
  } catch {
    return false;
  }
}

export const bridgeAddress = `${DEVICE_HOST}:${DEVICE_PORT}`;
