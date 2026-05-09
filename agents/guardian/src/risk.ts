// Risk-score lookup against the Argus signal-api.
//
// We poll instead of subscribing because the signal-api currently has
// no streaming endpoint and the data we want is the *result* of TEE
// consensus, not the raw signal stream.

import type { ConsensusEnvelope, Score } from './types.ts';

const SIGNAL_API = Bun.env.ARGUS_API ?? 'http://127.0.0.1:8787';

export class RiskError extends Error {}

export async function fetchRisk(addr: string): Promise<ConsensusEnvelope> {
  const url = `${SIGNAL_API}/risk/${addr}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new RiskError(`${res.status} ${text}`);
  return JSON.parse(text) as ConsensusEnvelope;
}

/** Numeric ordering of scores for compare-and-act logic. */
export function scoreLevel(s: Score): number {
  switch (s) {
    case 'CRITICAL':
      return 4;
    case 'RED':
      return 3;
    case 'ORANGE':
      return 2;
    case 'YELLOW':
      return 1;
    case 'NONE':
    default:
      return 0;
  }
}

export const signalApiBase = SIGNAL_API;
