// Argus ENS CCIP-Read gateway.
//
// Implements the off-chain side of EIP-3668 + ENSIP-10 wildcard
// resolution. An on-chain ArgusRiskResolver reverts every resolve()
// call with OffchainLookup pointing at this server; the client
// forwards the lookup here, we resolve it against the signal-api, and
// the resolver passes our reply back as the resolved value.
//
// Endpoints (per EIP-3668):
//   GET  /lookup/:sender/:data.json
//   POST /lookup            { sender, data }
//
// Response: { data: "0x..." } — ABI-encoded value matching the
// original record-query return type (string for text(), address for
// addr()).
//
// Plus, for humans:
//   GET  /health         — bridge + signal-api status
//   GET  /preview/:addr  — JSON view of every text record for an addr

import {
  type Hex,
  decodeAbiParameters,
  isHex,
} from 'viem';
import { decodeName } from './dns.ts';
import {
  ADDR_COIN_SELECTOR,
  ADDR_SELECTOR,
  EMPTY_ADDR,
  EMPTY_TEXT,
  TEXT_SELECTOR,
  decodeQuery,
  encodeAddr,
  encodeText,
  type Query,
} from './records.ts';
import {
  ConsensusError,
  fetchConsensus,
  signalApiBase,
  type ConsensusEnvelope,
} from './consensus.ts';

const PORT = Number(Bun.env.PORT ?? 8788);
const FRONTEND_URL_TEMPLATE =
  Bun.env.ARGUS_FRONTEND_URL_TEMPLATE ?? 'https://argus.eth.limo/risk/{addr}';

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
} as const;

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
      ...init?.headers,
    },
  });
}

function bad(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

// ---------------------------------------------------------------------------
// Wildcard name handling
// ---------------------------------------------------------------------------

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ADDR_HEX_RE = /^[0-9a-fA-F]{40}$/;

/** Pull the contract address from a wildcard ENS name like
 *  `0xabc...risks.argus.eth`.
 *
 *  - Accepts the address with or without the `0x` prefix.
 *  - Returns null if the leading label isn't a 20-byte hex address.
 */
export function addressFromLabels(labels: string[]): Hex | null {
  if (labels.length === 0) return null;
  const first = labels[0]!.toLowerCase();
  if (ADDR_RE.test(first)) return first as Hex;
  if (ADDR_HEX_RE.test(first)) return ('0x' + first) as Hex;
  return null;
}

// ---------------------------------------------------------------------------
// Record resolution
// ---------------------------------------------------------------------------

function frontendUrl(addr: string): string {
  return FRONTEND_URL_TEMPLATE.replaceAll('{addr}', addr);
}

function isoFromUnixSeconds(s: number): string {
  if (!s) return '';
  return new Date(s * 1000).toISOString();
}

/** Map a text-record key onto a value pulled from the consensus envelope.
 *  Unknown keys resolve to the empty string. */
export function textFromEnvelope(
  env: ConsensusEnvelope,
  key: string,
): string {
  switch (key) {
    case 'score':
    case 'risk_score':
      return env.score;
    case 'confidence':
      return String(env.confidence);
    case 'count':
      return String(env.count);
    case 'confirmed':
      return String(env.confirmed);
    case 'summary':
    case 'signals':
      return env.summary;
    case 'attestation':
      return env.attestation;
    case 'code_hash':
      return env.code_hash;
    case 'boot_commitment':
      return env.boot_commitment;
    case 'last_signal_ts':
      return String(env.last_signal_ts);
    case 'updated':
      // applet_ts_ns is monotonic since QEMU boot, not epoch — use the
      // signal timestamp (unix seconds) for the wall-clock value.
      return isoFromUnixSeconds(env.last_signal_ts);
    case 'url':
    case 'argus_url':
      return frontendUrl(env.addr);
    case 'description':
      return env.score === 'NONE'
        ? 'No threat signals submitted for this contract.'
        : `Argus risk: ${env.score} (${env.confirmed}/${env.count} confirmed signals).`;
    default:
      return '';
  }
}

async function resolveQuery(addr: Hex, q: Query): Promise<Hex> {
  if (q.kind === 'addr') {
    // For addr(), short-circuit: the gateway is the source of truth for
    // the wildcard name's "address" — it's the same address embedded in
    // the leading label. No need to round-trip through the applet.
    return encodeAddr(addr);
  }
  if (q.kind === 'text') {
    const env = await fetchConsensus(addr);
    const value = textFromEnvelope(env, q.key);
    return encodeText(value);
  }
  // Unsupported record types: empty bytes per ENSIP-10. We don't know
  // the exact return type, but viem-style clients accept "0x" as
  // unset, so return that.
  return '0x';
}

// ---------------------------------------------------------------------------
// CCIP-Read endpoint
// ---------------------------------------------------------------------------

interface LookupArgs {
  sender: string; // unused for now (no signature verification)
  data: Hex;
}

async function handleLookup(args: LookupArgs): Promise<Response> {
  if (!isHex(args.data)) return bad('data must be 0x-hex');

  // The on-chain resolver passed `abi.encode(name, callData)` as the
  // OffchainLookup callData. Decode it.
  let name: Hex;
  let callData: Hex;
  try {
    [name, callData] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes' }],
      args.data,
    );
  } catch (e) {
    return bad(`could not decode lookup data: ${(e as Error).message}`);
  }

  let labels: string[];
  try {
    labels = decodeName(name);
  } catch (e) {
    return bad(`could not decode DNS name: ${(e as Error).message}`);
  }

  const addr = addressFromLabels(labels);
  if (!addr) {
    // Wildcard didn't carry an address — return empty per record type.
    return emptyForCallData(callData);
  }

  const query = decodeQuery(callData);
  try {
    const data = await resolveQuery(addr, query);
    return json({ data });
  } catch (e) {
    if (e instanceof ConsensusError) {
      // signal-api unreachable: return the empty value so the client
      // sees "no record" rather than a hard 5xx (which CCIP clients
      // surface as failed resolution).
      console.error('[gateway] consensus error:', e.message);
      return emptyForCallData(callData);
    }
    return bad((e as Error).message, 500);
  }
}

function emptyForCallData(callData: Hex): Response {
  if (!isHex(callData)) return json({ data: '0x' });
  const sel = callData.slice(0, 10).toLowerCase();
  if (sel === TEXT_SELECTOR.toLowerCase()) return json({ data: EMPTY_TEXT });
  if (sel === ADDR_SELECTOR.toLowerCase()) return json({ data: EMPTY_ADDR });
  if (sel === ADDR_COIN_SELECTOR.toLowerCase()) return json({ data: EMPTY_ADDR });
  return json({ data: '0x' });
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

async function handleHealth(): Promise<Response> {
  let signalApi = 'unreachable';
  try {
    const r = await fetch(signalApiBase + '/health');
    if (r.ok) {
      const body = (await r.json()) as { status?: string };
      signalApi = body.status ?? 'unknown';
    }
  } catch {
    /* leave as unreachable */
  }
  return json({
    status: 'ok',
    signal_api: signalApiBase,
    signal_api_status: signalApi,
    frontend_url_template: FRONTEND_URL_TEMPLATE,
  });
}

async function handlePreview(addr: string): Promise<Response> {
  if (!ADDR_RE.test(addr)) return bad('bad address');
  const env = await fetchConsensus(addr.toLowerCase());
  const keys = [
    'score',
    'confidence',
    'count',
    'confirmed',
    'summary',
    'attestation',
    'code_hash',
    'boot_commitment',
    'updated',
    'url',
    'description',
  ];
  const records: Record<string, string> = {};
  for (const key of keys) records[key] = textFromEnvelope(env, key);
  return json({ addr: env.addr, records, envelope: env });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
    }
    try {
      if (req.method === 'GET' && path === '/health') return handleHealth();

      const preview = path.match(/^\/preview\/(0x[0-9a-fA-F]{40})$/);
      if (req.method === 'GET' && preview) return handlePreview(preview[1]!);

      // GET /lookup/:sender/:data.json
      const get = path.match(/^\/lookup\/(0x[0-9a-fA-F]+)\/(0x[0-9a-fA-F]+)\.json$/);
      if (req.method === 'GET' && get) {
        return handleLookup({ sender: get[1]!, data: get[2]! as Hex });
      }

      // POST /lookup  { sender, data }
      if (req.method === 'POST' && path === '/lookup') {
        const body = (await req.json()) as { sender?: string; data?: string };
        if (!body.sender || !body.data) return bad('sender and data required');
        return handleLookup({ sender: body.sender, data: body.data as Hex });
      }

      return bad('not found', 404);
    } catch (e) {
      console.error('[gateway]', e);
      return bad((e as Error).message ?? String(e), 500);
    }
  },
});

console.log(`[gateway] listening on http://localhost:${server.port}`);
console.log(`[gateway] signal-api    ${signalApiBase}`);
console.log(`[gateway] frontend tpl  ${FRONTEND_URL_TEMPLATE}`);
