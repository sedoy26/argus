// Contributor enrollment + access flags (in-memory; reset on process restart).
//
// Privileged / admin wallets come from ARGUS_PRIVILEGED_ADDRESSES / ARGUS_ADMIN_ADDRESSES only.
// Everyone else defaults to "user" until an admin approves a role request.
// Admin actions require EIP-191 personal_sign over a nonce-bound message.
// ARGUS_AUTH_STRICT is surfaced to the UI only (stricter messaging); it does not grant roles.

import { verifyMessage } from 'viem';

export type RequestedRole = 'scout' | 'guardian' | 'watcher';

export interface EnrollmentRecord {
  id: number;
  address: string;
  requestedRole: RequestedRole;
  description: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
}

const enrollments: EnrollmentRecord[] = [];
let nextEnrollmentId = 1;

/** Approved app-level roles (not the same as on-chain ArgusRegistry). */
const approvedRoles = new Map<string, Set<RequestedRole>>();

const nonceTtlMs = 10 * 60_000;
const nonces = new Map<string, { nonce: string; exp: number }>();

function parseAddrList(raw: string | undefined): Set<string> {
  const s = new Set<string>();
  if (!raw) return s;
  for (const part of raw.split(',')) {
    const a = part.trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(a)) s.add(a);
  }
  return s;
}

export function authStrict(): boolean {
  return Bun.env.ARGUS_AUTH_STRICT === '1';
}

export function privilegedAddresses(): Set<string> {
  return parseAddrList(Bun.env.ARGUS_PRIVILEGED_ADDRESSES);
}

export function adminAddresses(): Set<string> {
  const a = parseAddrList(Bun.env.ARGUS_ADMIN_ADDRESSES);
  if (a.size > 0) return a;
  return privilegedAddresses();
}

/** Deploy-team allowlist (Scout UI + skip enrollment). Not tied to `ARGUS_AUTH_STRICT`. */
export function isPrivileged(addr: string): boolean {
  return privilegedAddresses().has(addr.toLowerCase());
}

/**
 * Admin moderation + demo reset. Uses `ARGUS_ADMIN_ADDRESSES`, or the privileged set if unset.
 * `ARGUS_AUTH_STRICT` only affects what the UI shows about signature policy — never elevates random wallets.
 */
export function isAdmin(addr: string): boolean {
  return adminAddresses().has(addr.toLowerCase());
}

export function issueNonce(scope: string, address: string): string {
  const key = `${scope}:${address.toLowerCase()}`;
  const nonce = crypto.randomUUID().replace(/-/g, '');
  nonces.set(key, { nonce, exp: Date.now() + nonceTtlMs });
  return nonce;
}

export function peekNonce(scope: string, address: string): string | null {
  const key = `${scope}:${address.toLowerCase()}`;
  const e = nonces.get(key);
  if (!e || Date.now() > e.exp) return null;
  return e.nonce;
}

function consumeNonce(scope: string, address: string, nonce: string): boolean {
  const key = `${scope}:${address.toLowerCase()}`;
  const e = nonces.get(key);
  if (!e || e.nonce !== nonce || Date.now() > e.exp) return false;
  nonces.delete(key);
  return true;
}

function enrollmentUserMessage(args: {
  address: string;
  role: RequestedRole;
  description: string;
  nonce: string;
}): string {
  return [
    'Argus contributor enrollment',
    '',
    `Wallet: ${args.address}`,
    `Requested role: ${args.role}`,
    `Summary: ${args.description.slice(0, 2000)}`,
    `Nonce: ${args.nonce}`,
  ].join('\n');
}

function adminModerationMessage(args: {
  action: 'list' | 'approve' | 'reject';
  enrollmentId?: number;
  nonce: string;
}): string {
  const lines = ['Argus enrollment moderation', '', `Action: ${args.action}`, `Nonce: ${args.nonce}`];
  if (args.enrollmentId != null) lines.push(`Enrollment ID: ${args.enrollmentId}`);
  return lines.join('\n');
}

export async function verifyWalletSig(
  address: string,
  message: string,
  signature: string,
): Promise<boolean> {
  try {
    const ok = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
    return ok;
  } catch {
    return false;
  }
}

export async function submitEnrollment(args: {
  address: string;
  role: RequestedRole;
  description: string;
  nonce: string;
  signature: string;
}): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const addr = args.address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return { ok: false, error: 'bad address' };
  if (!['scout', 'guardian', 'watcher'].includes(args.role)) {
    return { ok: false, error: 'bad role' };
  }
  if (!args.description.trim()) return { ok: false, error: 'description required' };
  if (peekNonce('enroll', addr) !== args.nonce) {
    return { ok: false, error: 'invalid or expired nonce — request a new one' };
  }
  const message = enrollmentUserMessage({
    address: addr,
    role: args.role,
    description: args.description,
    nonce: args.nonce,
  });
  const ok = await verifyWalletSig(addr, message, args.signature);
  if (!ok) return { ok: false, error: 'signature does not match wallet' };
  if (!consumeNonce('enroll', addr, args.nonce)) {
    return { ok: false, error: 'nonce already used' };
  }

  const pending = enrollments.filter(
    (e) => e.address === addr && e.status === 'pending',
  );
  if (pending.length > 0) {
    return { ok: false, error: 'you already have a pending request' };
  }

  const id = nextEnrollmentId++;
  enrollments.push({
    id,
    address: addr,
    requestedRole: args.role,
    description: args.description.trim(),
    status: 'pending',
    createdAt: Date.now(),
  });
  return { ok: true, id };
}

export function listPendingEnrollments(): EnrollmentRecord[] {
  return enrollments.filter((e) => e.status === 'pending');
}

export async function adminListEnrollments(args: {
  adminAddress: string;
  nonce: string;
  signature: string;
}): Promise<EnrollmentRecord[] | { error: string }> {
  const admin = args.adminAddress.toLowerCase();
  if (!isAdmin(admin)) return { error: 'not an admin wallet' };
  if (peekNonce('admin', admin) !== args.nonce) {
    return { error: 'invalid or expired admin nonce' };
  }
  const message = adminModerationMessage({ action: 'list', nonce: args.nonce });
  const ok = await verifyWalletSig(admin, message, args.signature);
  if (!ok) return { error: 'bad admin signature' };
  if (!consumeNonce('admin', admin, args.nonce)) return { error: 'nonce already used' };
  return listPendingEnrollments();
}

export async function adminSetEnrollmentStatus(args: {
  adminAddress: string;
  nonce: string;
  signature: string;
  enrollmentId: number;
  decision: 'approve' | 'reject';
}): Promise<{ ok: true } | { error: string }> {
  const admin = args.adminAddress.toLowerCase();
  if (!isAdmin(admin)) return { error: 'not an admin wallet' };
  if (peekNonce('admin', admin) !== args.nonce) {
    return { error: 'invalid or expired admin nonce' };
  }
  const message = adminModerationMessage({
    action: args.decision,
    enrollmentId: args.enrollmentId,
    nonce: args.nonce,
  });
  const ok = await verifyWalletSig(admin, message, args.signature);
  if (!ok) return { error: 'bad admin signature' };
  if (!consumeNonce('admin', admin, args.nonce)) return { error: 'nonce already used' };

  const rec = enrollments.find((e) => e.id === args.enrollmentId);
  if (!rec || rec.status !== 'pending') return { error: 'enrollment not found or not pending' };

  if (args.decision === 'reject') {
    rec.status = 'rejected';
    return { ok: true };
  }
  rec.status = 'approved';
  let set = approvedRoles.get(rec.address);
  if (!set) {
    set = new Set();
    approvedRoles.set(rec.address, set);
  }
  set.add(rec.requestedRole);
  return { ok: true };
}

/** EIP-191 message for POST /demo/reset — keep in sync with dashboard `buildAdminDemoResetMessage`. */
export function buildAdminDemoResetMessage(args: { nonce: string }): string {
  return [
    'Argus hosted demo reset',
    '',
    'This authorizes clearing in-memory signals, events, and demo enrollments on the signal-api.',
    `Nonce: ${args.nonce}`,
  ].join('\n');
}

export async function verifyAdminDemoReset(args: {
  adminAddress: string;
  nonce: string;
  signature: string;
}): Promise<{ ok: true } | { error: string }> {
  const admin = args.adminAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(admin)) return { error: 'bad admin address' };
  if (!isAdmin(admin)) return { error: 'not an admin wallet' };
  if (peekNonce('admin', admin) !== args.nonce) {
    return { error: 'invalid or expired admin nonce' };
  }
  const message = buildAdminDemoResetMessage({ nonce: args.nonce });
  const ok = await verifyWalletSig(admin, message, args.signature);
  if (!ok) return { error: 'bad admin signature' };
  if (!consumeNonce('admin', admin, args.nonce)) return { error: 'nonce already used' };
  return { ok: true };
}

/** Wipe pending enrollments, role grants, and auth nonces (hosted demo reset). */
export function resetEnrollmentDemoState(): void {
  enrollments.length = 0;
  nextEnrollmentId = 1;
  approvedRoles.clear();
  nonces.clear();
}

export function accessForAddress(address: string | null): {
  privileged: boolean;
  isAdmin: boolean;
  approvedRoles: RequestedRole[];
  pending: EnrollmentRecord | null;
} {
  if (!address || !/^0x[0-9a-f]{40}$/i.test(address)) {
    return { privileged: false, isAdmin: false, approvedRoles: [], pending: null };
  }
  const a = address.toLowerCase();
  const priv = isPrivileged(a);
  const adm = isAdmin(a);
  const roles = [...(approvedRoles.get(a) ?? [])];
  const pending =
    enrollments.find((e) => e.address === a && e.status === 'pending') ?? null;
  return { privileged: priv, isAdmin: adm, approvedRoles: roles, pending };
}
