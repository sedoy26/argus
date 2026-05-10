// Push guardian revoke milestones into signal-api live feed (demo line).

import { signalApiBase } from './risk.ts';

async function postTelemetry(message: string, detail: Record<string, unknown>): Promise<void> {
  const secret = Bun.env.ARGUS_TELEMETRY_SECRET ?? '';
  if (!secret) return;

  const url = `${signalApiBase}/telemetry`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-argus-telemetry': secret,
      },
      body: JSON.stringify({ message, detail }),
    });
  } catch {
    /* best-effort */
  }
}

/** Generic ingest for demos (KMS pipeline, milestones). Logs to console if secret unset. */
export async function notifyArgusTelemetry(
  message: string,
  detail: Record<string, unknown>,
): Promise<void> {
  if (!Bun.env.ARGUS_TELEMETRY_SECRET) {
    console.warn('[telemetry] ARGUS_TELEMETRY_SECRET unset — not posting to signal-api:', message);
    return;
  }
  await postTelemetry(message, detail);
}

export async function notifyGuardianRevoke(p: {
  wallet: string;
  token: string;
  spender: string;
  txHash: string;
  signingMode: 'kms' | 'local';
  score: string;
}): Promise<void> {
  const message =
    p.signingMode === 'kms'
      ? `Guardian revoke signed via Space KMS ✓ — ${p.txHash.slice(0, 10)}…`
      : `Guardian revoke (local dev key) — ${p.txHash.slice(0, 10)}…`;
  await postTelemetry(message, {
    kind: 'guardian_revoke',
    space_kms_signed: p.signingMode === 'kms',
    signed_via: p.signingMode === 'kms' ? 'space_kms' : 'local_dev_key',
    txHash: p.txHash,
    wallet: p.wallet,
    token: p.token,
    spender: p.spender,
    score: p.score,
  });
}
