// Shared Apify actor call: prefers X402 (APIFY_X402_PRIVATE_KEY) over bearer token.

import type { Hex } from 'viem';
import { fetchWithX402, parseX402Settlement } from './apifyX402.ts';

const APIFY_BASE = Bun.env.APIFY_BASE_URL ?? 'https://api.apify.com/v2';

export type ApifyCallMeta = {
  usedX402: boolean;
  usedBearer: boolean;
  x402PaymentTx?: string;
  x402Network?: string;
};

export async function runApifyActorSync(
  actorSlug: string,
  body: Record<string, unknown>,
): Promise<{ rows: Array<Record<string, unknown>>; meta: ApifyCallMeta }> {
  const url = `${APIFY_BASE}/acts/${actorSlug}/run-sync-get-dataset-items?clean=1`;
  const token = Bun.env.APIFY_TOKEN ?? '';
  const x402Key = Bun.env.APIFY_X402_PRIVATE_KEY as Hex | undefined;

  const meta: ApifyCallMeta = { usedX402: false, usedBearer: false };

  if (x402Key) {
    meta.usedX402 = true;
    const res = await fetchWithX402(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      x402Key,
    );
    const settlement = parseX402Settlement(res);
    const payRef = settlement.transaction ?? settlement.tx;
    if (payRef) {
      meta.x402PaymentTx = payRef;
      meta.x402Network = settlement.network;
    }
    if (!res.ok) {
      throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 240)}`);
    }
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    return { rows, meta };
  }

  if (!token) {
    throw new Error('Set APIFY_X402_PRIVATE_KEY (X402 / USDC on Base) or APIFY_TOKEN for Apify');
  }
  meta.usedBearer = true;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 240)}`);
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return { rows, meta };
}
