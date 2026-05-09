// Signal types + pipe-encoding for the Argus Trusted Applet.
//
// The applet's `Signal` method consumes a pipe-delimited line:
//   SUBMIT|<addr>|<chain>|<threat>|<verdict>|<evhash>|<submitter>|<rep>|<ts>
//
// Wire schema in platform/tee/ARGUS-PROTOCOL.md.

import { createHash } from 'node:crypto';

export type Verdict = 'CONFIRMED' | 'UNCONFIRMED' | 'DISPUTED';

export interface SignalSubmission {
  contractAddress: string; // 0x + 40 hex
  chainId: number;
  threatType: string; // e.g. "SWAT-001"
  verdict: Verdict;
  evidence: unknown; // freeform — we hash its canonical JSON
  submitter: string; // ENS name or address
  reputation: number; // 0..100
  timestamp?: number; // unix seconds; defaults to now
}

export interface ConsensusEnvelope {
  score: 'NONE' | 'YELLOW' | 'ORANGE' | 'RED' | 'CRITICAL';
  confidence: number;
  count: number;
  confirmed: number;
  addr: string;
  summary: string;
  last_signal_ts: number;
  applet_ts_ns: number;
  code_hash: string;
  boot_commitment: string;
  attestation: string;
}

export interface BootInfo {
  boot_commitment: string;
  code_hash: string;
  code_hash_input: string;
  boot_ts_ns: number;
  now_ns: number;
  signal_count: number;
  max_signals: number;
}

export class ValidationError extends Error {}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const THREAT_RE = /^[A-Za-z0-9-]{1,16}$/;
const VERDICTS: ReadonlySet<Verdict> = new Set([
  'CONFIRMED',
  'UNCONFIRMED',
  'DISPUTED',
]);
const PIPE_BAN = /[|\r\n\t]/;

export function validate(s: SignalSubmission): void {
  if (!ADDR_RE.test(s.contractAddress)) {
    throw new ValidationError(`bad contractAddress: ${s.contractAddress}`);
  }
  if (!Number.isInteger(s.chainId) || s.chainId < 0 || s.chainId > 2 ** 32 - 1) {
    throw new ValidationError(`bad chainId: ${s.chainId}`);
  }
  if (!THREAT_RE.test(s.threatType)) {
    throw new ValidationError(`bad threatType: ${s.threatType}`);
  }
  if (!VERDICTS.has(s.verdict)) {
    throw new ValidationError(`bad verdict: ${s.verdict}`);
  }
  if (typeof s.submitter !== 'string' || !s.submitter || s.submitter.length > 64) {
    throw new ValidationError(`bad submitter`);
  }
  if (PIPE_BAN.test(s.submitter)) {
    throw new ValidationError(`submitter cannot contain |, \\r, \\n, \\t`);
  }
  if (
    !Number.isInteger(s.reputation) ||
    s.reputation < 0 ||
    s.reputation > 100
  ) {
    throw new ValidationError(`reputation must be 0..100`);
  }
}

/** Canonical JSON for evidence, with sorted keys. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ':' +
          canonicalize((value as Record<string, unknown>)[k]),
      )
      .join(',') +
    '}'
  );
}

export function evidenceHash(evidence: unknown): string {
  const canon = canonicalize(evidence ?? null);
  const h = createHash('sha256').update(canon).digest('hex');
  return '0x' + h;
}

export function encodeSubmit(s: SignalSubmission, evHash: string): string {
  if (!HASH_RE.test(evHash)) {
    throw new ValidationError(`bad evidence hash`);
  }
  const ts = s.timestamp ?? Math.floor(Date.now() / 1000);
  const fields = [
    'SUBMIT',
    s.contractAddress.toLowerCase(),
    String(s.chainId),
    s.threatType,
    s.verdict,
    evHash.toLowerCase(),
    s.submitter,
    String(s.reputation),
    String(ts),
  ];
  return fields.join('|');
}

export function parseEnvelope(raw: string): ConsensusEnvelope {
  return JSON.parse(raw) as ConsensusEnvelope;
}

export function parseBootInfo(raw: string): BootInfo {
  return JSON.parse(raw) as BootInfo;
}

export function normalizeAddress(s: string): string {
  if (!ADDR_RE.test(s)) {
    throw new ValidationError(`bad address: ${s}`);
  }
  return s.toLowerCase();
}
