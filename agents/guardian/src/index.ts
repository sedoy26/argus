// Guardian entrypoint.
//
// Configuration priority:
//   1. ENS text records on guardian.agents.<ARGUS_ENS_ROOT>
//      (threshold, signal_api — allows live updates without restart)
//   2. Environment variables
//   3. Built-in defaults
//
// Set ENS_BOOTSTRAP=0 to skip ENS and use env-only config.

import { createPublicClient, http, type Address } from 'viem';
import { sepolia } from 'viem/chains';
import { Guardian, type GuardianConfig } from './guardian.ts';
import { signerFromEnv, LocalSigner } from './signer.ts';
import type { ProtectedWallet, Score } from './types.ts';

const ENS_ROOT = Bun.env.ARGUS_ENS_ROOT ?? 'argus-security.eth';
const ENS_BOOTSTRAP = Bun.env.ENS_BOOTSTRAP !== '0';
const AGENT_ENS_NAME = `guardian.agents.${ENS_ROOT}`;

/** Load guardian config from ENS text records (non-fatal). */
async function loadEnsGuardianConfig(): Promise<Partial<{ threshold: Score }>> {
  const rpcUrl = Bun.env.SEPOLIA_RPC_URL ?? Bun.env.RPC_URL;
  if (!rpcUrl) return {};
  try {
    const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
    const [thresholdRaw] = await Promise.all([
      client.getEnsText({ name: AGENT_ENS_NAME, key: 'threshold' }),
    ]);
    const SCORES: Score[] = ['NONE', 'YELLOW', 'ORANGE', 'RED', 'CRITICAL'];
    const out: Partial<{ threshold: Score }> = {};
    if (thresholdRaw && SCORES.includes(thresholdRaw as Score)) {
      out.threshold = thresholdRaw as Score;
      console.log(`[guardian] ENS threshold = ${out.threshold} (from ${AGENT_ENS_NAME})`);
    }
    return out;
  } catch (e) {
    console.warn(`[guardian] ENS bootstrap failed: ${(e as Error).message}`);
    return {};
  }
}

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
  console.log(`[guardian] identity      ${AGENT_ENS_NAME}`);

  // --- ENS bootstrap ---
  const ensConfig = ENS_BOOTSTRAP ? await loadEnsGuardianConfig() : {};

  // Primary signer (KMS or local) always protects itself.
  const protectedWallets: ProtectedWallet[] = [
    { label: 'self', address: signer.address },
  ];

  // Optional: GUARDIAN_EXTRA_KEYS=0xpk1,0xpk2,... adds additional
  // demo wallets each protected by their own LocalSigner.
  const extraKeys = (Bun.env.GUARDIAN_EXTRA_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const extraSigners = extraKeys.map((pk, i) => {
    const s = new LocalSigner(pk as `0x${string}`);
    protectedWallets.push({ label: `demo-wallet-${i + 1}`, address: s.address });
    return s;
  });

  // Build signer map: KMS signer covers its own address; extra LocalSigners
  // cover each additional demo wallet.
  const signerMap = new Map<string, typeof signer>();
  signerMap.set(signer.address.toLowerCase(), signer);
  for (const s of extraSigners) {
    signerMap.set(s.address.toLowerCase(), s);
  }

  const config: GuardianConfig = {
    spender: envAddress('GUARDIAN_SPENDER'),
    tokens: envAddressList('GUARDIAN_TOKENS'),
    protected: protectedWallets,
    signerMap,
    threshold: ensConfig.threshold ?? envScore('GUARDIAN_THRESHOLD', 'CRITICAL'),
    pollMs: Number(Bun.env.GUARDIAN_POLL_MS ?? 5000),
    rpcUrl: Bun.env.RPC_URL ?? 'http://127.0.0.1:8545',
  };

  console.log(`[guardian] signer        ${signer.address} (${signer.signingBackend === 'kms' ? 'Space KMS / Orbitport' : 'local private key'})`);
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
