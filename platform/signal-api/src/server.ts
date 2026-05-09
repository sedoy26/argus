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
import { emit, latest, since } from './events.ts';
import { queryStore, standaloneBootInfo, storeSignal } from './store.ts';
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

// When STANDALONE=1 the server never touches the GoTEE bridge.
// All consensus is computed in-process from submitted signals.
// This is the Railway / CI mode.
const STANDALONE = Bun.env.STANDALONE === '1';

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
  if (STANDALONE) {
    return json({ status: 'ok', mode: 'standalone', bridge: 'n/a' });
  }
  const ok = await ping();
  return json(
    { status: ok ? 'ok' : 'unreachable', bridge: bridgeAddress },
    { status: ok ? 200 : 503 },
  );
}

async function handleBoot(): Promise<Response> {
  if (STANDALONE) {
    return json(standaloneBootInfo);
  }
  const raw = await callApplet('BootInfo', '');
  const info = parseBootInfo(raw);
  return json(info);
}

const SCORE_LEVEL: Record<string, number> = { NONE: 0, YELLOW: 1, ORANGE: 2, RED: 3, CRITICAL: 4 };
const prevScores = new Map<string, string>();

async function handleSubmit(req: Request): Promise<Response> {
  const body = await readJson(req);
  const submission = body as SignalSubmission;
  validate(submission);
  const evHash = evidenceHash(submission.evidence);

  let envelope;
  if (STANDALONE) {
    envelope = storeSignal(submission, evHash);
  } else {
    const wire = encodeSubmit(submission, evHash);
    const raw = await callApplet('Signal', wire);
    envelope = parseEnvelope(raw);
  }

  // Emit signal_received event
  emit('signal_received', `${submission.submitter} reported ${submission.threatType} on ${submission.contractAddress.slice(0, 10)}… [${submission.verdict}]`, {
    address: submission.contractAddress,
    threatType: submission.threatType,
    verdict: submission.verdict,
    submitter: submission.submitter,
    reputation: submission.reputation,
    score: envelope.score,
    evidence_hash: evHash,
  });

  // Emit score_changed if escalated
  const prev = prevScores.get(envelope.addr) ?? 'NONE';
  if (envelope.score !== prev) {
    const escalated = (SCORE_LEVEL[envelope.score] ?? 0) > (SCORE_LEVEL[prev] ?? 0);
    emit('score_changed', `${envelope.addr.slice(0, 10)}… score ${prev} → ${envelope.score} (${envelope.confirmed}/${envelope.count} confirmed)`, {
      address: envelope.addr,
      prev,
      score: envelope.score,
      confirmed: envelope.confirmed,
      count: envelope.count,
      attestation: envelope.attestation,
      code_hash: envelope.code_hash,
      boot_commitment: envelope.boot_commitment,
    });
    prevScores.set(envelope.addr, envelope.score);

    // Emit guardian_trigger on CRITICAL or RED
    if ((SCORE_LEVEL[envelope.score] ?? 0) >= 3 && escalated) {
      emit('guardian_trigger', `⚠️  GUARDIAN TRIGGERED — ${envelope.score} on ${envelope.addr.slice(0, 10)}… — revoke all approvals`, {
        address: envelope.addr,
        score: envelope.score,
        attestation: envelope.attestation,
      });
    }
  }

  if (STANDALONE) {
    return json({ submitted: { evidence_hash: evHash }, consensus: envelope });
  }
  return json({ submitted: { evidence_hash: evHash, wire: encodeSubmit(submission, evHash) }, consensus: envelope });
}

async function handleRisk(addressParam: string): Promise<Response> {
  const addr = normalizeAddress(addressParam);
  if (STANDALONE) {
    const envelope = queryStore(addr);
    return json(envelope);
  }
  const raw = await callApplet('Query', `QUERY|${addr}`);
  const envelope = parseEnvelope(raw);
  return json(envelope);
}

function handleEvents(url: URL): Response {
  const afterId = Number(url.searchParams.get('after') ?? '0');
  const n = Number(url.searchParams.get('n') ?? '50');
  const events = afterId > 0 ? since(afterId) : latest(n);
  return json(events, { headers: { 'cache-control': 'no-store' } });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    // CORS for dashboard dev server
    const corsHeaders = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    try {
      let res: Response;
      if (req.method === 'GET' && path === '/health') res = await handleHealth();
      else if (req.method === 'GET' && path === '/boot') res = await handleBoot();
      else if (req.method === 'POST' && path === '/signals') res = await handleSubmit(req);
      else if (req.method === 'GET' && path === '/events') res = handleEvents(url);
      else {
        const m = path.match(/^\/risk\/([^/]+)$/);
        if (req.method === 'GET' && m) res = await handleRisk(m[1]!);
        else res = bad('not found', 404);
      }
      // Attach CORS headers to every response
      const merged = new Response(res.body, res);
      for (const [k, v] of Object.entries(corsHeaders)) merged.headers.set(k, v);
      return merged;
    } catch (e) {
      if (e instanceof ValidationError) return bad(e.message);
      console.error('[signal-api]', e);
      return bad((e as Error).message ?? String(e), 502);
    }
  },
});

// Emit boot event once on startup
emit('boot', `Argus signal-api started (${STANDALONE ? 'standalone' : 'TEE bridge'})`, {
  mode: STANDALONE ? 'standalone' : 'bridge',
  bridge: STANDALONE ? null : bridgeAddress,
});

console.log(`[signal-api] listening on http://localhost:${server.port}`);
console.log(`[signal-api] mode          ${STANDALONE ? 'standalone (no TEE)' : 'bridge → ' + bridgeAddress}`);
