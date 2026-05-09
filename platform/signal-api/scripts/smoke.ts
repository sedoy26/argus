// End-to-end smoke test for the signal API.
//
// Assumes:
//   1. `make qemu` is running in another shell (bridge on 127.0.0.1:4000)
//   2. `bun run dev` is serving the signal API on http://localhost:8787
//
// Usage:
//   bun run smoke

import { createHash } from 'node:crypto';

const API = Bun.env.ARGUS_API ?? 'http://localhost:8787';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(API + path);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

const ADDR = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const EV1 = { source: 'sourcify', finding: 'arbitrary-call in execute()' };
const EV2 = { source: 'on-chain', finding: 'OwnershipTransferred to fresh EOA' };
const EV3 = { source: 'apify', finding: 'tweet from peckshield' };

async function main() {
  console.log('1. /health');
  console.log(JSON.stringify(await getJson('/health')));

  console.log('\n2. /boot');
  const boot = await getJson<{ boot_commitment: string; code_hash: string }>(
    '/boot',
  );
  console.log(JSON.stringify(boot));

  console.log('\n3. submit 3 distinct CONFIRMED signals → expect CRITICAL');
  for (const [submitter, ev, rep] of [
    ['watcher-sourcify.argus.eth', EV1, 90],
    ['watcher-onchain.argus.eth', EV2, 80],
    ['scout-apify.argus.eth', EV3, 75],
  ] as const) {
    const r = await postJson<{
      submitted: { evidence_hash: string };
      consensus: { score: string; confirmed: number; attestation: string };
    }>('/signals', {
      contractAddress: ADDR,
      chainId: 11155111,
      threatType: 'SWAT-001',
      verdict: 'CONFIRMED',
      evidence: ev,
      submitter,
      reputation: rep,
    });
    console.log(
      `   ${submitter.padEnd(34)} → score=${r.consensus.score} confirmed=${r.consensus.confirmed}`,
    );
    // Sanity: returned evidence_hash should match what we'd compute locally.
    const expected = '0x' + createHash('sha256').update(canonical(ev)).digest('hex');
    if (r.submitted.evidence_hash !== expected) {
      throw new Error(
        `evidence_hash mismatch: ${r.submitted.evidence_hash} vs ${expected}`,
      );
    }
  }

  console.log('\n4. /risk/:address');
  const risk = await getJson<{
    score: string;
    confirmed: number;
    attestation: string;
  }>('/risk/' + ADDR);
  console.log(JSON.stringify(risk, null, 2));
  if (risk.score !== 'CRITICAL') {
    throw new Error(`expected CRITICAL, got ${risk.score}`);
  }
  console.log('\nOK');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map(
        (k) =>
          JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k]),
      )
      .join(',') +
    '}'
  );
}

await main();
