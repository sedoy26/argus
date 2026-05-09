// Thin wrappers over the Vite dev-server proxies.
//   /api → signal-api
//   /gw  → ens-resolver gateway

import type {
  ArgusEvent,
  BootInfo,
  ConsensusEnvelope,
  GatewayPreview,
  HealthInfo,
} from './types';

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

export async function getHealth(): Promise<HealthInfo> {
  return jsonOrThrow<HealthInfo>(await fetch('/api/health'));
}

export async function getBoot(): Promise<BootInfo> {
  return jsonOrThrow<BootInfo>(await fetch('/api/boot'));
}

export async function getRisk(addr: string): Promise<ConsensusEnvelope> {
  return jsonOrThrow<ConsensusEnvelope>(await fetch(`/api/risk/${addr}`));
}

export async function getPreview(addr: string): Promise<GatewayPreview | null> {
  try {
    const r = await fetch(`/gw/preview/${addr}`);
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
    await fetch('/api/signals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    }),
  );
}

export async function getEvents(afterId?: number): Promise<ArgusEvent[]> {
  const url = afterId ? `/api/events?after=${afterId}` : '/api/events?n=50';
  return jsonOrThrow<ArgusEvent[]>(await fetch(url));
}
