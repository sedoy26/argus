// Dev: Vite proxies `/api` → signal-api and `/gw` → ens-resolver.
// Production: set `VITE_SIGNAL_API` and `VITE_GATEWAY_URL` (build-time) so
// the browser calls your hosted services directly (CORS must allow the UI origin).
//
// Hybrid (Railway UI + local QEMU): an https:// dashboard cannot call http://localhost
// (mixed content). Use an HTTPS tunnel to your machine, then either set build-time VITE_*
// to the tunnel URLs or set localStorage overrides (see README).

import type {
  ArgusEvent,
  BootInfo,
  ConsensusEnvelope,
  GatewayPreview,
  HealthInfo,
} from './types';

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

const LS_SIGNAL = 'ARGUS_SIGNAL_API_OVERRIDE';
const LS_GATEWAY = 'ARGUS_GATEWAY_URL_OVERRIDE';

function readLocalOverride(key: string): string {
  if (typeof window === 'undefined') return '';
  try {
    const v = window.localStorage.getItem(key)?.trim();
    return v ? trimSlash(v) : '';
  } catch {
    return '';
  }
}

/** Effective signal-api origin (no trailing slash). Override wins for hybrid / tunnel. */
export function signalApiOrigin(): string {
  return readLocalOverride(LS_SIGNAL) || trimSlash(import.meta.env.VITE_SIGNAL_API ?? '');
}

/** Effective ens-gateway origin. */
export function gatewayOrigin(): string {
  return readLocalOverride(LS_GATEWAY) || trimSlash(import.meta.env.VITE_GATEWAY_URL ?? '');
}

/** Path on signal-api, e.g. `/health` or `/risk/0x…`. */
export function signalUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  const base = signalApiOrigin();
  if (base) return `${base}${p}`;
  return `/api${p}`;
}

/** Path on ens gateway, e.g. `/preview/0x…`. */
export function gatewayUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  const base = gatewayOrigin();
  if (base) return `${base}${p}`;
  return `/gw${p}`;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    const empty = !text.trim();
    const hint500 =
      res.status >= 500 && empty
        ? signalApiOrigin()
          ? ' Empty response from signal-api — check deployment / ARGUS logs.'
          : ' Empty response usually means the Vite proxy could not reach signal-api (wrong port). Default proxy is :8787; ./reset.sh runs signal-api on :8788 — then use VITE_API_TARGET=http://127.0.0.1:8788 (and VITE_GW_TARGET=http://127.0.0.1:8789).'
        : '';
    const hint404 =
      res.status === 404 && /not found/i.test(text)
        ? signalApiOrigin()
          ? ' Path missing on signal-api — redeploy API or check VITE_SIGNAL_API / localStorage ARGUS_SIGNAL_API_OVERRIDE matches the running service.'
          : ' If /api/health works in the browser but this path 404s, restart signal-api after git pull. If nothing listens on the Vite proxy port, use `cd dashboard && bun run dev:reset` when ./reset.sh is running.'
        : '';
    throw new Error(`${res.status}: ${empty ? '(empty)' : text}${hint500}${hint404}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${res.status}: expected JSON, got ${text.slice(0, 160)}`);
  }
}

export async function getHealth(): Promise<HealthInfo> {
  return jsonOrThrow<HealthInfo>(await fetch(signalUrl('/health')));
}

export async function getBoot(): Promise<BootInfo> {
  return jsonOrThrow<BootInfo>(await fetch(signalUrl('/boot')));
}

export async function getRisk(addr: string): Promise<ConsensusEnvelope> {
  return jsonOrThrow<ConsensusEnvelope>(await fetch(signalUrl(`/risk/${addr}`)));
}

export async function getPreview(addr: string): Promise<GatewayPreview | null> {
  try {
    const r = await fetch(gatewayUrl(`/preview/${addr}`));
    if (!r.ok) return null;
    return (await r.json()) as GatewayPreview;
  } catch {
    return null;
  }
}

export interface SubmitSignalArgs {
  contractAddress: string;
  chainId: number;
  threatType: string;
  verdict: 'CONFIRMED' | 'UNCONFIRMED' | 'DISPUTED';
  evidence: unknown;
  submitter: string;
  reputation: number;
}

export async function submitSignal(args: SubmitSignalArgs): Promise<{
  consensus: ConsensusEnvelope;
}> {
  return jsonOrThrow<{ consensus: ConsensusEnvelope }>(
    await fetch(signalUrl('/signals'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    }),
  );
}

export async function getEvents(afterId?: number): Promise<ArgusEvent[]> {
  const q = afterId ? `?after=${afterId}` : '?n=50';
  return jsonOrThrow<ArgusEvent[]>(await fetch(signalUrl(`/events${q}`)));
}

export interface IntelResult {
  ok: boolean;
  steps: string[];
  contractAddress: string;
  text: string;
  evidence_hash: string;
  consensus: ConsensusEnvelope;
}

export async function submitIntel(args: { tweetUrl?: string; text?: string }): Promise<IntelResult> {
  return jsonOrThrow<IntelResult>(
    await fetch(signalUrl('/intel'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    }),
  );
}

// ── Social “scout agents” (server-side periodic pollers by profile URL) ─────

export type SocialAgentPlatform = 'reddit' | 'twitter';

export interface SocialAgentRow {
  id: string;
  profileUrl: string;
  platform: SocialAgentPlatform;
  pollMs: number;
  lastPollAt: number | null;
  lastError: string | null;
  postsProcessed: number;
}

export async function listSocialAgents(): Promise<SocialAgentRow[]> {
  const j = await jsonOrThrow<{ agents?: SocialAgentRow[] }>(
    await fetch(signalUrl('/agents/social')),
  );
  return j.agents ?? [];
}

export async function createSocialAgent(body: {
  profileUrl: string;
  pollSec?: number;
}): Promise<{ ok: boolean; agent: SocialAgentRow }> {
  return jsonOrThrow(
    await fetch(signalUrl('/agents/social'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function deleteSocialAgent(id: string): Promise<{ ok: boolean }> {
  return jsonOrThrow(
    await fetch(
      signalUrl(`/agents/social?id=${encodeURIComponent(id)}`),
      { method: 'DELETE' },
    ),
  );
}

// ── Access & contributor enrollment (signed) ───────────────────────────────

export interface AccessInfo {
  privileged: boolean;
  isAdmin: boolean;
  approvedRoles: string[];
  pending: {
    id: number;
    address: string;
    requestedRole: string;
    description: string;
    status: string;
    createdAt: number;
  } | null;
  authStrict: boolean;
}

function normalizeAccessPayload(raw: unknown): AccessInfo {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rolesRaw = o.approvedRoles;
  const approvedRoles = Array.isArray(rolesRaw)
    ? rolesRaw.filter((x): x is string => typeof x === 'string')
    : [];

  let pending: AccessInfo['pending'] = null;
  const pr = o.pending;
  if (pr && typeof pr === 'object' && !Array.isArray(pr)) {
    const p = pr as Record<string, unknown>;
    pending = {
      id: Number(p.id) || 0,
      address: String(p.address ?? ''),
      requestedRole: String(p.requestedRole ?? ''),
      description: String(p.description ?? ''),
      status: String(p.status ?? ''),
      createdAt: Number(p.createdAt) || 0,
    };
  }

  return {
    privileged: !!o.privileged,
    isAdmin: !!o.isAdmin,
    approvedRoles,
    pending,
    authStrict: !!o.authStrict,
  };
}

export async function getAccess(address: string): Promise<AccessInfo> {
  const raw = await jsonOrThrow<unknown>(
    await fetch(signalUrl(`/access?address=${encodeURIComponent(address)}`)),
  );
  return normalizeAccessPayload(raw);
}

export async function getAuthNonce(
  scope: 'user' | 'admin',
  address: string,
): Promise<{ nonce: string; scope: string; expiresInSec: number }> {
  return jsonOrThrow(
    await fetch(
      signalUrl(
        `/auth/nonce?scope=${encodeURIComponent(scope)}&address=${encodeURIComponent(address)}`,
      ),
    ),
  );
}

export function buildEnrollmentSignMessage(p: {
  address: string;
  role: string;
  description: string;
  nonce: string;
}): string {
  const a = p.address.toLowerCase();
  return [
    'Argus contributor enrollment',
    '',
    `Wallet: ${a}`,
    `Requested role: ${p.role}`,
    `Summary: ${p.description.slice(0, 2000)}`,
    `Nonce: ${p.nonce}`,
  ].join('\n');
}

export function buildAdminModerationMessage(p: {
  action: 'list' | 'approve' | 'reject';
  enrollmentId?: number;
  nonce: string;
}): string {
  const lines = ['Argus enrollment moderation', '', `Action: ${p.action}`, `Nonce: ${p.nonce}`];
  if (p.enrollmentId != null) lines.push(`Enrollment ID: ${p.enrollmentId}`);
  return lines.join('\n');
}

export async function walletPersonalSign(walletAddress: string, message: string): Promise<string> {
  const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params: unknown[] }) => Promise<string> } }).ethereum;
  if (!eth) throw new Error('No Ethereum wallet (install MetaMask)');
  return eth.request({
    method: 'personal_sign',
    params: [message, walletAddress],
  });
}

export async function connectEthereumWallet(): Promise<string> {
  const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<string[]> } }).ethereum;
  if (!eth) throw new Error('No Ethereum wallet (install MetaMask)');
  const acc = await eth.request({ method: 'eth_requestAccounts' });
  const a = acc[0];
  if (!a || !/^0x[0-9a-fA-F]{40}$/i.test(a)) throw new Error('No account returned');
  return a.toLowerCase();
}

/** Ask the wallet to drop this origin’s account permission (EIP-2255). Best-effort — clears app state either way. */
export async function revokeWalletConnection(): Promise<void> {
  const eth = (window as unknown as {
    ethereum?: {
      request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
      disconnect?: () => Promise<void>;
    };
  }).ethereum;
  if (!eth?.request) return;
  try {
    await eth.request({
      method: 'wallet_revokePermissions',
      params: [{ eth_accounts: {} }],
    });
  } catch {
    /* wallet may not implement revoke — still clear Argus session in the app */
  }
  if (typeof eth.disconnect === 'function') {
    try {
      await eth.disconnect();
    } catch {
      /* WC / some injected providers */
    }
  }
}

export async function submitEnrollmentRequest(p: {
  address: string;
  role: string;
  description: string;
  nonce: string;
  signature: string;
}): Promise<{ ok: boolean; id: number }> {
  return jsonOrThrow(
    await fetch(signalUrl('/enrollment'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(p),
    }),
  );
}

export interface EnrollmentRow {
  id: number;
  address: string;
  requestedRole: string;
  description: string;
  status: string;
  createdAt: number;
}

export async function adminListEnrollments(p: {
  adminAddress: string;
  nonce: string;
  signature: string;
}): Promise<EnrollmentRow[]> {
  const res = await fetch(signalUrl('/enrollment/moderate'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list', ...p }),
  });
  const j = (await res.json()) as { enrollments?: EnrollmentRow[]; error?: string };
  if (!res.ok) throw new Error(j.error ?? 'list failed');
  return j.enrollments ?? [];
}

export async function adminDecideEnrollment(p: {
  adminAddress: string;
  nonce: string;
  signature: string;
  enrollmentId: number;
  decision: 'approve' | 'reject';
}): Promise<void> {
  const res = await fetch(signalUrl('/enrollment/moderate'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: p.decision,
      adminAddress: p.adminAddress,
      nonce: p.nonce,
      signature: p.signature,
      enrollmentId: p.enrollmentId,
    }),
  });
  const j = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(j.error ?? 'moderation failed');
}
