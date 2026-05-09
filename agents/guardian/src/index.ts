// Guardian entrypoint. Boots from env vars and runs forever.

import type { Address } from 'viem';
import { Guardian, type GuardianConfig } from './guardian.ts';
import { signerFromEnv } from './signer.ts';
import type { ProtectedWallet, Score } from './types.ts';

function envAddress(name: string, dflt?: Address): Address {
  const v = Bun.env[name];
  if (!v) {
    if (dflt) return dflt;
    throw new Error(`missing env: ${name}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`bad address in ${name}: ${v}`);
  }
  return v.toLowerCase() as Address;
}

function envAddressList(name: string): Address[] {
  const v = Bun.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s, i) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
        throw new Error(`bad address in ${name}[${i}]: ${s}`);
      }
      return s.toLowerCase() as Address;
    });
}

const SCORES: ReadonlySet<Score> = new Set([
  'NONE',
  'YELLOW',
  'ORANGE',
  'RED',
  'CRITICAL',
]);

function envScore(name: string, dflt: Score): Score {
  const v = (Bun.env[name] ?? dflt) as Score;
  if (!SCORES.has(v)) throw new Error(`bad score in ${name}: ${v}`);
  return v;
}

async function main(): Promise<void> {
  const signer = await signerFromEnv();

  const protectedWallets: ProtectedWallet[] = [
    { label: 'self', address: signer.address },
  ];

  const config: GuardianConfig = {
    spender: envAddress('GUARDIAN_SPENDER'),
    tokens: envAddressList('GUARDIAN_TOKENS'),
    protected: protectedWallets,
    threshold: envScore('GUARDIAN_THRESHOLD', 'CRITICAL'),
    pollMs: Number(Bun.env.GUARDIAN_POLL_MS ?? 5000),
    rpcUrl: Bun.env.RPC_URL ?? 'http://127.0.0.1:8545',
  };

  console.log(`[guardian] signer        ${signer.address}`);
  console.log(`[guardian] spender       ${config.spender}`);
  console.log(`[guardian] tokens        ${config.tokens.join(', ')}`);
  console.log(`[guardian] threshold     ${config.threshold}`);
  console.log(`[guardian] rpc           ${config.rpcUrl}`);
  console.log(`[guardian] poll          ${config.pollMs} ms`);

  const guard = new Guardian(config, signer);
  guard.start();
  // Keep the process alive on Bun.
  await new Promise(() => {});
}

await main();
