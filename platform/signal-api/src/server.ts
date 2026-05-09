// Argus Signal API — Normal World HTTP host for the Trusted Applet.
//
// Watcher agents and the dashboard talk to this service over HTTP. We
// translate their JSON requests into the applet's pipe-delimited wire
// format, ship them across the GoTEE bridge (TCP :4000), and return
// the TEE-attested consensus envelope verbatim.
//
// Endpoints:
//   GET  /health             — bridge reachability
//   GET  /boot               — applet boot commitment + code hash
//   POST /signals            — submit a verified signal
//   GET  /risk/:address      — query consensus for a contract
//
// Defaults: HTTP on :8787, bridge at 127.0.0.1:4000 (override with
// PORT, DEVICE_HOST, DEVICE_PORT).

import { bridgeAddress, callApplet, ping } from './bridge.ts';
import {
  ValidationError,
  encodeSubmit,
  evidenceHash,
  normalizeAddress,
  parseBootInfo,
  parseEnvelope,
  validate,
  type SignalSubmission,
} from './signals.ts';

const PORT = Number(Bun.env.PORT ?? 8787);

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

function bad(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ValidationError('body must be JSON');
  }
}

async function handleHealth(): Promise<Response> {
  const ok = await ping();
  return json(
    { status: ok ? 'ok' : 'unreachable', bridge: bridgeAddress },
    { status: ok ? 200 : 503 },
  );
}

async function handleBoot(): Promise<Response> {
  const raw = await callApplet('BootInfo', '');
  const info = parseBootInfo(raw);
  return json(info);
}

async function handleSubmit(req: Request): Promise<Response> {
  const body = await readJson(req);
  const submission = body as SignalSubmission;
  validate(submission);
  const evHash = evidenceHash(submission.evidence);
  const wire = encodeSubmit(submission, evHash);
  const raw = await callApplet('Signal', wire);
  const envelope = parseEnvelope(raw);
  return json({ submitted: { evidence_hash: evHash, wire }, consensus: envelope });
}

async function handleRisk(addressParam: string): Promise<Response> {
  const addr = normalizeAddress(addressParam);
  const raw = await callApplet('Query', `QUERY|${addr}`);
  const envelope = parseEnvelope(raw);
  return json(envelope);
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/health') return handleHealth();
      if (req.method === 'GET' && path === '/boot') return handleBoot();
      if (req.method === 'POST' && path === '/signals') return handleSubmit(req);

      const m = path.match(/^\/risk\/([^/]+)$/);
      if (req.method === 'GET' && m) return handleRisk(m[1]!);

      return bad('not found', 404);
    } catch (e) {
      if (e instanceof ValidationError) return bad(e.message);
      console.error('[signal-api]', e);
      return bad((e as Error).message ?? String(e), 502);
    }
  },
});

console.log(`[signal-api] listening on http://localhost:${server.port}`);
console.log(`[signal-api] bridge        ${bridgeAddress}`);
