// Standalone in-memory consensus store.
//
// Used when STANDALONE=1 (Railway / CI). Replaces the GoTEE bridge.
// Accepts signal submissions directly and computes consensus using
// the same SWAT scoring rules the Trusted Applet implements.
//
// Scoring rules (mirrors platform/tee/src/main.rs):
//   0 signals                  → NONE
//   1 unconfirmed signal       → YELLOW
//   1 confirmed signal         → ORANGE
//   2+ confirmed signals       → RED
//   3+ signals, 1+ on-chain    → CRITICAL

import { createHash } from 'node:crypto';
import type { ConsensusEnvelope, SignalSubmission, Verdict } from './signals.ts';

interface StoredSignal {
  threatType: string;
  verdict: Verdict;
  submitter: string;
  reputation: number;
  evidenceHash: string;
  timestamp: number;
  isOnChain: boolean;
}

const signals = new Map<string, StoredSignal[]>();

const STANDALONE_CODE_HASH =
  '0x' + 'ab'.repeat(32); // placeholder — no real TEE in standalone mode
const BOOT_COMMITMENT =
  '0x' + 'cd'.repeat(32);
const BOOT_TS = BigInt(Date.now()) * 1_000_000n;

export function storeSignal(
  submission: SignalSubmission,
  evidenceHash: string,
): ConsensusEnvelope {
  const addr = submission.contractAddress.toLowerCase();
  const existing = signals.get(addr) ?? [];

  // Deduplicate: same submitter + threat type = update in place
  const idx = existing.findIndex(
    (s) =>
      s.submitter === submission.submitter &&
      s.threatType === submission.threatType,
  );

  const entry: StoredSignal = {
    threatType: submission.threatType,
    verdict: submission.verdict,
    submitter: submission.submitter,
    reputation: submission.reputation,
    evidenceHash,
    timestamp: submission.timestamp ?? Math.floor(Date.now() / 1000),
    isOnChain:
      submission.threatType === 'SWAT-002' ||
      submission.threatType === 'SWAT-003',
  };

  if (idx >= 0) {
    existing[idx] = entry;
  } else {
    existing.push(entry);
  }
  signals.set(addr, existing);
  return computeEnvelope(addr, existing);
}

export function queryStore(addr: string): ConsensusEnvelope {
  const list = signals.get(addr.toLowerCase()) ?? [];
  return computeEnvelope(addr.toLowerCase(), list);
}

function computeEnvelope(
  addr: string,
  list: StoredSignal[],
): ConsensusEnvelope {
  const confirmed = list.filter((s) => s.verdict === 'CONFIRMED');
  const onChain = list.filter((s) => s.isOnChain);
  const count = list.length;
  const confirmedCount = confirmed.length;
  const lastTs =
    list.length > 0 ? Math.max(...list.map((s) => s.timestamp)) : 0;

  let score: ConsensusEnvelope['score'] = 'NONE';
  if (count === 0) {
    score = 'NONE';
  } else if (confirmedCount === 0) {
    score = 'YELLOW';
  } else if (confirmedCount === 1) {
    score = 'ORANGE';
  } else if (confirmedCount >= 2 && onChain.length === 0) {
    score = 'RED';
  } else if (confirmedCount >= 2 || (count >= 3 && onChain.length >= 1)) {
    score = 'CRITICAL';
  }

  const confidence =
    count === 0
      ? 0
      : Math.min(
          100,
          Math.round(
            (confirmedCount / count) * 70 +
              Math.min(count, 5) * 6,
          ),
        );

  const summary =
    list
      .map((s) => `${s.threatType}:${s.verdict}`)
      .join(',') || '';

  const attestation = standaloneAttestation(addr, score, lastTs);

  return {
    score,
    confidence,
    count,
    confirmed: confirmedCount,
    addr,
    summary,
    last_signal_ts: lastTs,
    applet_ts_ns: Number(BigInt(Date.now()) * 1_000_000n - BOOT_TS),
    code_hash: STANDALONE_CODE_HASH,
    boot_commitment: BOOT_COMMITMENT,
    attestation,
  };
}

/** Deterministic mock attestation — not a real TEE signature, but
 *  consistent across calls for the same state so the dashboard can
 *  display it as a fingerprint. */
function standaloneAttestation(
  addr: string,
  score: string,
  ts: number,
): string {
  const payload = `${addr}:${score}:${ts}:${STANDALONE_CODE_HASH}`;
  return '0x' + createHash('sha256').update(payload).digest('hex');
}

export const standaloneBootInfo = {
  boot_commitment: BOOT_COMMITMENT,
  code_hash: STANDALONE_CODE_HASH,
  code_hash_input: 'standalone-mode',
  boot_ts_ns: Number(BOOT_TS),
  get now_ns() {
    return Number(BigInt(Date.now()) * 1_000_000n);
  },
  get signal_count() {
    return [...signals.values()].reduce((n, list) => n + list.length, 0);
  },
  max_signals: 10000,
};
