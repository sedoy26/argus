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
//   POST /intel              — scrape URL / text → corroborated signals
//   GET|POST|DELETE /agents/social — profile URL pollers (Reddit + X/Twitter, in-memory demo)
//   GET  /risk/:address      — query consensus for a contract
//
// Defaults: HTTP on :8787, bridge at 127.0.0.1:4000 (override with
// PORT, DEVICE_HOST, DEVICE_PORT).

import { OrbitportSDK } from '@spacecomputer-io/orbitport-sdk-ts';
import { bridgeAddress, callApplet, ping } from './bridge.ts';
import { clearEventRing, emit, latest, since } from './events.ts';
import { clearStandaloneSignals, queryStore, standaloneBootInfo, storeSignal } from './store.ts';
import {
  accessForAddress,
  adminListEnrollments,
  adminSetEnrollmentStatus,
  authStrict,
  issueNonce,
  resetEnrollmentDemoState,
  submitEnrollment,
  verifyAdminDemoReset,
  type RequestedRole,
} from './enrollments.ts';
import {
  ValidationError,
  encodeSubmit,
  evidenceHash,
  normalizeAddress,
  parseBootInfo,
  parseEnvelope,
  validate,
  type ConsensusEnvelope,
  type SignalSubmission,
} from './signals.ts';
import {
  listSocialAgents,
  registerSocialIntelRunner,
  startSocialAgent,
  stopAllSocialAgents,
  stopSocialAgent,
  type IntelCorroborationResult,
} from './socialAgents.ts';
import { runApifyActorSync } from './apifyActor.ts';

// ── cTRNG (SpaceComputer cosmic true random) ──────────────────────────────────
// Used to generate hardware-attested nonces for TEE attestation proofs.
// Falls back to crypto.getRandomValues() if credentials are absent so
// local dev still works without SpaceComputer creds.
const ORBITPORT_CLIENT_ID     = Bun.env.ORBITPORT_CLIENT_ID     ?? '';
const ORBITPORT_CLIENT_SECRET = Bun.env.ORBITPORT_CLIENT_SECRET ?? '';
const _ctrngSdk = (ORBITPORT_CLIENT_ID && ORBITPORT_CLIENT_SECRET)
  ? new OrbitportSDK({
      config: {
        clientId: ORBITPORT_CLIENT_ID,
        clientSecret: ORBITPORT_CLIENT_SECRET,
      },
    })
  : null;
if (_ctrngSdk) console.log('[signal-api] cTRNG: SpaceComputer Orbitport enabled');
else           console.log('[signal-api] cTRNG: local fallback (no Orbitport creds)');

async function hardwareNonce(): Promise<{ nonce: string; source: string }> {
  if (_ctrngSdk) {
    try {
      const res = await _ctrngSdk.ctrng.random({ src: 'rng' });
      // SDK returns ServiceResult; actual payload is res.data
      // Shape: { service, src, data: "<hex string>" } or { ctrng: number[] }
      const payload = res.data as unknown as Record<string, unknown>;
      let hexStr: string | undefined;
      if (typeof payload['data'] === 'string') {
        hexStr = payload['data'].slice(0, 32); // first 16 bytes = 32 hex chars
      } else if (Array.isArray(payload['ctrng'])) {
        hexStr = (payload['ctrng'] as number[]).slice(0, 16)
          .map(b => b.toString(16).padStart(2, '0')).join('');
      }
      if (hexStr) {
        return { nonce: `0x${hexStr}`, source: 'SpaceComputer cTRNG (cosmic hardware)' };
      }
    } catch { /* fallthrough */ }
  }
  // Fallback: CSPRNG from Node/Bun runtime
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return { nonce: `0x${nonce}`, source: 'crypto.getRandomValues (local fallback)' };
}

const PORT = Number(Bun.env.PORT ?? 8787);

// When STANDALONE=1 the server never touches the GoTEE bridge.
// All consensus is computed in-process from submitted signals.
// This is the Railway / CI mode.
const STANDALONE = Bun.env.STANDALONE === '1';

// Project mention → contract address mapping (demo registry).
// In production this is backed by ENS text records.
const PROJECT_REGISTRY: Record<string, string> = {
  fakeswap: '0x3b38fe80891ec608829e941ef965e1c96d3460d6',
  fakeswapnet: '0x3b38fe80891ec608829e941ef965e1c96d3460d6',
};

// Known-scout fallback tweets: if Apify fails to scrape a tweet URL
// (unauthenticated rate-limit), we use the scripted content so the rest
// of the pipeline still fires end-to-end during the demo.
const SCOUT_FALLBACK_TWEETS: Record<string, string> = {
  cryptoham42: '🚨 @FakeSwapNet has an arbitrary call vulnerability — execute() can drain all user approvals. Holders at risk. REVOKE NOW! #DeFiSecurity',
};

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

// Shared signal processing — called by both /signals and /intel.
async function processSignal(submission: SignalSubmission) {
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

  emit('signal_received', `${submission.submitter} reported ${submission.threatType} on ${submission.contractAddress.slice(0, 10)}… [${submission.verdict}]`, {
    address: submission.contractAddress,
    threatType: submission.threatType,
    verdict: submission.verdict,
    submitter: submission.submitter,
    reputation: submission.reputation,
    score: envelope.score,
    evidence_hash: evHash,
  });

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

    if ((SCORE_LEVEL[envelope.score] ?? 0) >= 3 && escalated) {
      emit('guardian_trigger', `⚠️  GUARDIAN TRIGGERED — ${envelope.score} on ${envelope.addr.slice(0, 10)}… — revoke all approvals`, {
        address: envelope.addr,
        score: envelope.score,
        attestation: envelope.attestation,
      });
    }
  }

  return { evHash, envelope };
}

/** Shared corroboration path for POST /intel and Reddit scout agents. */
async function runIntelCorroborationFromText(
  intelText: string,
  source: string,
  steps: string[],
): Promise<IntelCorroborationResult> {
  if (!intelText.trim()) return { error: 'no text to analyze' };

  steps.push('resolving_address');
  const lower = intelText.toLowerCase();
  let contractAddress: string | undefined;

  for (const [key, addr] of Object.entries(PROJECT_REGISTRY)) {
    if (lower.includes(key)) {
      contractAddress = addr;
      break;
    }
  }
  const addrMatch = intelText.match(/0x[0-9a-fA-F]{40}/);
  if (!contractAddress && addrMatch) contractAddress = addrMatch[0].toLowerCase();

  if (!contractAddress) {
    return {
      error:
        'could not resolve a contract address from this intel (mention @FakeSwapNet or include a 0x address)',
    };
  }

  steps.push('address_resolved');
  emit('info', `Address resolved: ${contractAddress.slice(0, 10)}…`, { contractAddress });

  steps.push('submitting_signal');

  const corroborators = [
    { submitter: 'scout.agents.argus-security.eth', reputation: 80 },
    { submitter: 'peckshield.scouts.argus-security.eth', reputation: 90 },
    { submitter: 'certik.scouts.argus-security.eth', reputation: 85 },
  ];

  let lastEnvelope: ConsensusEnvelope | undefined;
  let lastHash = '';
  for (const { submitter, reputation } of corroborators) {
    const submission: SignalSubmission = {
      contractAddress,
      chainId: 11155111,
      threatType: 'SWAT-001',
      verdict: 'CONFIRMED',
      evidence: {
        source: submitter === corroborators[0]!.submitter ? source : `corroboration:${submitter}`,
        note: intelText.slice(0, 300),
      },
      submitter,
      reputation,
    };
    const { evHash, envelope } = await processSignal(submission);
    lastEnvelope = envelope;
    lastHash = evHash;
  }

  steps.push('done');

  if (!lastEnvelope) return { error: 'pipeline produced no consensus envelope' };

  return {
    steps,
    contractAddress,
    text: intelText,
    evidence_hash: lastHash,
    consensus: lastEnvelope,
  };
}

async function handleSubmit(req: Request): Promise<Response> {
  const body = await readJson(req);
  const submission = body as SignalSubmission;
  const { evHash, envelope } = await processSignal(submission);
  if (STANDALONE) {
    return json({ submitted: { evidence_hash: evHash }, consensus: envelope });
  }
  return json({ submitted: { evidence_hash: evHash, wire: encodeSubmit(submission, evidenceHash(submission.evidence)) }, consensus: envelope });
}

// POST /intel — accepts { tweetUrl?, text? }
// Scrapes tweet via Apify (if tweetUrl), resolves contract address,
// and submits a signal through the full TEE pipeline.
async function handleIntel(req: Request): Promise<Response> {
  const body = await readJson(req) as { tweetUrl?: string; text?: string };
  const steps: string[] = [];
  let intelText = body.text ?? '';
  let source = 'dashboard-scout';

  if (body.tweetUrl) {
    const sourceUrl = body.tweetUrl;
    steps.push('fetching_tweet');

    // ── Reddit: public JSON API, no auth needed ───────────────────────────
    if (sourceUrl.includes('reddit.com/r/')) {
      emit('info', `Scout fetching Reddit post…`, { url: sourceUrl });
      try {
        const jsonUrl = sourceUrl.replace(/\?.*$/, '').replace(/\/$/, '') + '.json';
        const r = await fetch(jsonUrl, { headers: { 'user-agent': 'ArgusBot/1.0' } });
        if (r.ok) {
          const data = (await r.json()) as Array<{ data: { children: Array<{ data: Record<string, unknown> }> } }>;
          const post = data[0]?.data?.children?.[0]?.data ?? {};
          const title = String(post['title'] ?? '');
          const body2 = String(post['selftext'] ?? '');
          const author = String(post['author'] ?? 'reddit');
          intelText = [title, body2].filter(Boolean).join('\n');
          source = `reddit:${author}:${sourceUrl}`;
          emit('info', `Reddit post fetched from u/${author}: "${intelText.slice(0, 80)}…"`, { source });
        }
      } catch (e) {
        emit('info', `Reddit fetch failed: ${(e as Error).message}`, { url: sourceUrl });
      }
    }

    // ── Twitter: try Apify, fall back to provided text ────────────────────
    else {
      emit('info', `Scout fetching tweet via Apify…`, { tweetUrl: sourceUrl });

      const handleMatch = sourceUrl.match(/x\.com\/([^/]+)\/status\//i) ?? sourceUrl.match(/twitter\.com\/([^/]+)\/status\//i);
      const tweetAuthor = handleMatch?.[1]?.toLowerCase() ?? '';
      let apifyOk = false;

      if (Bun.env.APIFY_X402_PRIVATE_KEY || Bun.env.APIFY_TOKEN) {
        try {
          const { rows: tweets, meta } = await runApifyActorSync('automation-lab~twitter-scraper', {
            startUrls: [sourceUrl],
            mode: 'tweets',
            maxItems: 3,
          });
          const fetched = tweets.map((t) => String(t['text'] ?? t['fullText'] ?? '')).filter(Boolean).join('\n');
          if (fetched.trim()) {
            intelText = fetched;
            apifyOk = true;
          }
          if (meta.usedX402) {
            emit(
              'info',
              meta.x402PaymentTx
                ? `Scout paid Apify via X402 — settlement tx ${String(meta.x402PaymentTx).slice(0, 14)}… ✓`
                : 'Scout used Apify X402 (USDC on Base) — request completed ✓',
              {
                x402: true,
                apifySettlementTx: meta.x402PaymentTx ?? null,
                x402Network: meta.x402Network ?? 'eip155:8453',
              },
            );
          }
        } catch {
          /* fall through */
        }
      }

      source = `twitter:${tweetAuthor}:${sourceUrl}`;

      if (!apifyOk) {
        if (body.text && body.text.trim().length > 0) {
          intelText = body.text.trim();
          emit('info', `Apify rate-limited — using submitted tweet text from @${tweetAuthor}`, { tweetUrl: sourceUrl });
        } else {
          emit('info', `Apify scrape failed — no text to analyze`, { tweetUrl: sourceUrl });
        }
      }

      emit('info', `Tweet intel: "${intelText.slice(0, 80)}${intelText.length > 80 ? '…' : ''}"`, { source, apifyOk });
    }

    steps.push('tweet_fetched');
  }

  if (!intelText.trim()) return bad('no text to analyze');

  const out = await runIntelCorroborationFromText(intelText, source, steps);
  if ('error' in out) return bad(out.error);
  return json({
    ok: true,
    steps: out.steps,
    contractAddress: out.contractAddress,
    text: out.text,
    evidence_hash: out.evidence_hash,
    consensus: out.consensus,
  });
}

async function handleSimulateTx(req: Request): Promise<Response> {
  const body = await readJson(req) as { from?: string; to?: string; data?: string; value?: string; chainId?: number };
  const to = (body.to ?? '').toLowerCase();
  const chainId = body.chainId ?? 11155111;

  // ── 0. cTRNG attestation nonce (SpaceComputer hardware randomness) ────────
  const { nonce: attestationNonce, source: nonceSource } = await hardwareNonce();

  // ── 1. Sourcify verification check (real API) ─────────────────────────────
  let sourcifyMatch: string | null = null;
  let sourcifyChecked = false;
  try {
    const sRes = await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${to}`, {
      headers: { 'user-agent': 'Argus-TEE-Guard/1.0' },
    });
    sourcifyChecked = true; // we got a response either way
    if (sRes.ok) {
      const sData = await sRes.json() as { match?: string | null; runtimeMatch?: string | null };
      // null means unverified (HTTP 200 with null fields)
      sourcifyMatch = sData.match ?? sData.runtimeMatch ?? null;
      emit('info', `Sourcify.dev verification for ${to.slice(0, 10)}…`, {
        sourcifyChecked: true,
        sourcifyMatch,
        sourcifyVerificationUrl: `https://sourcify.dev/server/v2/contract/${chainId}/${to}`,
      });
    } else {
      // 404 = contract not found on Sourcify = not verified
      sourcifyMatch = null;
      emit('info', `Sourcify.dev lookup HTTP ${sRes.status} for ${to.slice(0, 10)}…`, {
        sourcifyChecked: true,
        sourcifyVerificationUrl: `https://sourcify.dev/server/v2/contract/${chainId}/${to}`,
      });
    }
  } catch { /* Sourcify unreachable — fall through to score check */ }

  // ── 2. TEE risk score ─────────────────────────────────────────────────────
  let score = 'NONE';
  let attestation = '';
  let teeEnvelope: Record<string, unknown> = {};
  try {
    if (STANDALONE) {
      const env = queryStore(to);
      score = env.score;
      attestation = env.attestation;
      teeEnvelope = env as unknown as Record<string, unknown>;
    } else {
      const raw = await callApplet('Query', `QUERY|${to}`);
      const env = parseEnvelope(raw);
      score = env.score;
      attestation = env.attestation;
      teeEnvelope = env as unknown as Record<string, unknown>;
    }
  } catch { /* treat as unknown */ }

  // ── 3. Block decision ─────────────────────────────────────────────────────
  // Block if: contract not on Sourcify AND/OR risk score ≥ ORANGE
  const notVerified = sourcifyChecked && sourcifyMatch === null;
  const highRisk = (SCORE_LEVEL[score] ?? 0) >= 2;
  const blocked = notVerified || highRisk;

  const reasons: string[] = [];
  if (notVerified) reasons.push('Contract not verified on Sourcify — real Uniswap is (exact_match)');
  if (highRisk) reasons.push(`TEE consensus score: ${score} — multiple scouts confirmed threat`);

  emit(blocked ? 'tx_blocked' : 'info',
    blocked
      ? `⛔ TX BLOCKED — SWAT-004 phishing drain intercepted [sourcify:${sourcifyMatch ?? 'null'} tee:${score} nonce:${attestationNonce.slice(0, 10)}]`
      : `TX simulation: ${to.slice(0, 10)}… — allowed (sourcify:${sourcifyMatch ?? 'null'} tee:${score})`,
    {
      address: to,
      score,
      sourcify_match: sourcifyMatch,
      sourcify_checked: sourcifyChecked,
      attestation: attestation.slice(0, 20),
      threat: 'SWAT-004',
      blocked,
      nonce: attestationNonce,
    },
  );

  return json({
    blocked,
    score,
    threat: 'SWAT-004',
    reasons,
    proof: {
      sourcify: {
        checked: sourcifyChecked,
        match: sourcifyMatch,
        url: `https://sourcify.dev/server/v2/contract/${chainId}/${to}`,
        verdict: sourcifyMatch ? `verified (${sourcifyMatch})` : 'NOT VERIFIED',
      },
      tee: {
        score,
        attestation,
        confirmed: teeEnvelope['confirmed'] ?? 0,
        count: teeEnvelope['count'] ?? 0,
        code_hash: teeEnvelope['code_hash'] ?? '',
        boot_commitment: teeEnvelope['boot_commitment'] ?? '',
      },
      nonce: {
        value: attestationNonce,
        source: nonceSource,
        purpose: 'attestation-replay-prevention',
      },
    },
    tee_verdict: blocked ? 'REVERTED' : 'ALLOWED',
    funds_protected: blocked,
  });
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

function handleAuthNonce(url: URL): Response {
  const scope = url.searchParams.get('scope') ?? 'user';
  const address = (url.searchParams.get('address') ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return bad('query address must be 0x + 40 hex', 400);
  const keyScope = scope === 'admin' ? 'admin' : 'enroll';
  const nonce = issueNonce(keyScope, address);
  return json({ nonce, scope: keyScope, expiresInSec: 600 });
}

function handleAccess(url: URL): Response {
  const address = url.searchParams.get('address');
  const acc = accessForAddress(address);
  return json({ ...acc, authStrict: authStrict() });
}

async function handleEnrollmentApply(req: Request): Promise<Response> {
  const body = (await readJson(req)) as {
    address?: string;
    role?: string;
    description?: string;
    nonce?: string;
    signature?: string;
  };
  const address = (body.address ?? '').trim().toLowerCase();
  const role = body.role as RequestedRole;
  const description = body.description ?? '';
  const nonce = body.nonce ?? '';
  const signature = body.signature ?? '';
  if (!signature.startsWith('0x')) return bad('signature must be hex', 400);
  const r = await submitEnrollment({
    address,
    role,
    description,
    nonce,
    signature,
  });
  if (!r.ok) return bad(r.error);
  emit('info', `Contributor enrollment #${r.id}: ${role} from ${address.slice(0, 10)}…`, {
    enrollmentId: r.id,
    address,
    role,
  });
  return json({ ok: true, id: r.id });
}

async function handleEnrollmentModerate(req: Request): Promise<Response> {
  const body = (await readJson(req)) as {
    action?: string;
    adminAddress?: string;
    nonce?: string;
    signature?: string;
    enrollmentId?: number;
  };
  const adminAddress = (body.adminAddress ?? '').trim().toLowerCase();
  const nonce = body.nonce ?? '';
  const signature = body.signature ?? '';
  if (!signature.startsWith('0x')) return bad('signature must be hex', 400);

  if (body.action === 'list') {
    const rows = await adminListEnrollments({
      adminAddress,
      nonce,
      signature,
    });
    if (Array.isArray(rows)) return json({ enrollments: rows });
    return bad((rows as { error: string }).error, 403);
  }
  if (body.action === 'approve' || body.action === 'reject') {
    if (!Number.isInteger(body.enrollmentId)) return bad('enrollmentId required', 400);
    const r = await adminSetEnrollmentStatus({
      adminAddress,
      nonce,
      signature,
      enrollmentId: body.enrollmentId!,
      decision: body.action,
    });
    if ('error' in r) return bad(r.error, 403);
    emit('info', `Enrollment ${body.enrollmentId} ${body.action}d by admin ${adminAddress.slice(0, 10)}…`, {
      enrollmentId: body.enrollmentId,
      decision: body.action,
    });
    return json({ ok: true });
  }
  return bad('action must be list | approve | reject', 400);
}

async function handleSocialAgentCreate(req: Request): Promise<Response> {
  const body = (await readJson(req)) as { profileUrl?: string; redditUser?: string; pollSec?: number };
  const fromLegacy = (body.redditUser ?? '').trim();
  const profileUrl =
    (body.profileUrl ?? '').trim() ||
    (fromLegacy ? `https://www.reddit.com/user/${fromLegacy.replace(/^u\//i, '')}` : '');
  if (!profileUrl) return bad('profileUrl required (or legacy redditUser)', 400);
  const pollSec = body.pollSec ?? 120;
  try {
    const keys = Object.keys(PROJECT_REGISTRY);
    const agent = startSocialAgent(profileUrl, pollSec * 1000, keys);
    return json({ ok: true, agent });
  } catch (e) {
    return bad((e as Error).message ?? String(e), 400);
  }
}

function handleSocialAgentDelete(url: URL): Response {
  const id = url.searchParams.get('id') ?? '';
  if (!id) return bad('id query required', 400);
  if (!stopSocialAgent(id)) return bad('agent not found', 404);
  return json({ ok: true });
}

/** Best-effort ingest from guardian / other agents (Space KMS demo line). */
async function handleTelemetry(req: Request): Promise<Response> {
  const secret = Bun.env.ARGUS_TELEMETRY_SECRET ?? '';
  if (!secret || req.headers.get('x-argus-telemetry') !== secret) {
    return bad('telemetry unauthorized', 401);
  }
  const body = (await readJson(req)) as { message?: string; detail?: Record<string, unknown> };
  if (!body.message || typeof body.message !== 'string') return bad('message required', 400);
  emit('info', body.message, body.detail ?? {});
  return json({ ok: true });
}

/**
 * Hosted demo reset: clears event feed, score-change memory, social pollers,
 * and enrollment demo state. In STANDALONE mode also clears consensus signals.
 *
 * Auth (either):
 * - `x-argus-demo-reset` header = env `ARGUS_DEMO_RESET_SECRET` (scripts / CI), or
 * - JSON body `{ adminAddress, nonce, signature }` with admin EIP-191 over `buildAdminDemoResetMessage` (dashboard).
 *
 * On-chain approvals are not changed — use `scripts/reset-sepolia-approvals.sh` (cast).
 */
async function handleDemoReset(req: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await readJson(req)) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const headerSecret = Bun.env.ARGUS_DEMO_RESET_SECRET ?? '';
  const headerOk = headerSecret !== '' && req.headers.get('x-argus-demo-reset') === headerSecret;

  const adminAddress = String(body.adminAddress ?? '').trim().toLowerCase();
  const nonce = String(body.nonce ?? '');
  const signature = String(body.signature ?? '');

  const adminPayload =
    adminAddress &&
    /^0x[0-9a-f]{40}$/.test(adminAddress) &&
    nonce &&
    signature.startsWith('0x');

  let adminOk = false;
  if (adminPayload) {
    const r = await verifyAdminDemoReset({ adminAddress, nonce, signature });
    if ('ok' in r) adminOk = true;
    else return bad(r.error, 403);
  }

  if (!headerOk && !adminOk) {
    return bad(
      'demo reset unauthorized — use admin-signed JSON body or x-argus-demo-reset header',
      401,
    );
  }

  prevScores.clear();
  clearEventRing();
  const socialStopped = stopAllSocialAgents();
  resetEnrollmentDemoState();
  let signalsCleared = false;
  if (STANDALONE) {
    clearStandaloneSignals();
    signalsCleared = true;
  }

  emit('info', 'Demo state reset — feed cleared; re-approve on Sepolia if needed', {
    standalone: STANDALONE,
    signalsCleared,
    socialAgentsStopped: socialStopped,
  });

  return json({
    ok: true,
    standalone: STANDALONE,
    signalsCleared,
    socialAgentsStopped: socialStopped,
    note:
      STANDALONE
        ? 'Risk scores are back to NONE until new signals. Restore MockUSDC→FakeSwap approvals on-chain for the guardian demo.'
        : 'TEE bridge mode: applet signal memory unchanged — restart QEMU / applet for a full consensus reset.',
  });
}

registerSocialIntelRunner(runIntelCorroborationFromText);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    // CORS for dashboard dev server
    const corsHeaders = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type, x-argus-telemetry, x-argus-demo-reset',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    try {
      let res: Response;
      if (req.method === 'GET' && path === '/health') res = await handleHealth();
      else if (req.method === 'GET' && path === '/boot') res = await handleBoot();
      else if (req.method === 'POST' && path === '/signals') res = await handleSubmit(req);
      else if (req.method === 'POST' && path === '/intel') res = await handleIntel(req);
      else if (req.method === 'POST' && path === '/simulate-tx') res = await handleSimulateTx(req);
      else if (req.method === 'POST' && path === '/telemetry') res = await handleTelemetry(req);
      else if (req.method === 'POST' && path === '/demo/reset') res = await handleDemoReset(req);
      else if (req.method === 'GET' && path === '/auth/nonce') res = handleAuthNonce(url);
      else if (req.method === 'GET' && path === '/access') res = handleAccess(url);
      else if (req.method === 'POST' && path === '/enrollment') res = await handleEnrollmentApply(req);
      else if (req.method === 'POST' && path === '/enrollment/moderate') res = await handleEnrollmentModerate(req);
      else if (req.method === 'GET' && path === '/events') res = handleEvents(url);
      else if (req.method === 'GET' && path === '/agents/social') res = json({ agents: listSocialAgents() });
      else if (req.method === 'POST' && path === '/agents/social') res = await handleSocialAgentCreate(req);
      else if (req.method === 'DELETE' && path === '/agents/social') res = handleSocialAgentDelete(url);
      else if (req.method === 'GET' && path === '/agents/reddit') res = json({ agents: listSocialAgents() });
      else if (req.method === 'POST' && path === '/agents/reddit') res = await handleSocialAgentCreate(req);
      else if (req.method === 'DELETE' && path === '/agents/reddit') res = handleSocialAgentDelete(url);
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
