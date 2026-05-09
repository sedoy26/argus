// Host webserver for the Square example — exposes GET /square?x=N over
// HTTP and forwards to the applet via the Trusted OS bridge on
// 127.0.0.1:4000 (QEMU edition; override DEVICE_HOST=10.0.0.1 for
// hardware).
//
//   bun run examples/square/server.ts
//   curl 'http://localhost:3000/square?x=7'      # {"x":7,"result":49}

const DEVICE_HOST = Bun.env.DEVICE_HOST ?? '127.0.0.1';
const DEVICE_PORT = Number(Bun.env.DEVICE_PORT ?? 4000);

// Each request spawns `nc` to talk to the bridge. The protocol is a
// single newline-terminated JSON request, single JSON reply, then close.
async function callApplet(method: string, input: string): Promise<string> {
  const req = JSON.stringify({ Method: method, Input: input }) + '\n';
  const proc = Bun.spawn(['nc', '-w', '3', DEVICE_HOST, String(DEVICE_PORT)], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
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

const server = Bun.serve({
  port: 3000,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== '/square') return new Response('not found', { status: 404 });

    const x = url.searchParams.get('x') ?? '0';
    try {
      const out = await callApplet('Square', x);
      return Response.json({ x: Number(x), result: Number(out) });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  },
});

console.log(`listening on http://${server.hostname}:${server.port}/square?x=7`);
