// Push guardian revoke milestones into signal-api live feed (demo line).

import { signalApiBase } from './risk.ts';

export async function notifyGuardianRevoke(p: {
  wallet: string;
  token: string;
  spender: string;
  txHash: string;
  signingMode: 'kms' | 'local';
  score: string;
}): Promise<void> {
  const secret = Bun.env.ARGUS_TELEMETRY_SECRET ?? '';
  if (!secret) return;

  const url = `${signalApiBase}/telemetry`;
  const body = {
    message:
      p.signingMode === 'kms'
        ? `Guardian revoke signed via Space KMS ✓ — ${p.txHash.slice(0, 10)}…`
        : `Guardian revoke (local dev key) — ${p.txHash.slice(0, 10)}…`,
    detail: {
      kind: 'guardian_revoke',
      space_kms_signed: p.signingMode === 'kms',
      signed_via: p.signingMode === 'kms' ? 'space_kms' : 'local_dev_key',
      txHash: p.txHash,
      wallet: p.wallet,
      token: p.token,
      spender: p.spender,
      score: p.score,
    },
  };

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-argus-telemetry': secret,
      },
      body: JSON.stringify(body),
    });
  } catch {
    /* best-effort */
  }
}
