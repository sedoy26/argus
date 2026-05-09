// Talks to the Argus signal-api to fetch a contract's current consensus
// envelope. We treat the signal-api as the single source of truth — it
// owns the bridge to the Trusted Applet, including any caching.

const SIGNAL_API = Bun.env.ARGUS_API ?? 'http://127.0.0.1:8787';

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

export class ConsensusError extends Error {}

export async function fetchConsensus(addr: string): Promise<ConsensusEnvelope> {
  const url = `${SIGNAL_API}/risk/${addr}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new ConsensusError(`signal-api unreachable at ${url}: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ConsensusError(`signal-api ${res.status}: ${text}`);
  }
  return JSON.parse(text) as ConsensusEnvelope;
}

export const signalApiBase = SIGNAL_API;
