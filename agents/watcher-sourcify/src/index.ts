// Watcher entrypoint.
//
// Configuration is loaded in priority order:
//   1. ENS text records on watcher-sourcify.agents.<ARGUS_ENS_ROOT>
//      (allows live network-wide config updates without redeploying)
//   2. Environment variables (WATCHER_SUBMITTER, WATCHER_REPUTATION, …)
//   3. Built-in defaults
//
// ENS bootstrap requires SEPOLIA_RPC_URL (or RPC_URL) in env.
// Set ENS_BOOTSTRAP=0 to skip ENS and use env-only config.

import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { SourcifyHttp, type SourcifyHttpOptions } from './sourcify.ts';
import { Watcher, type WatchTarget } from './watcher.ts';

const ENS_ROOT = Bun.env.ARGUS_ENS_ROOT ?? 'argus-security.eth';
const ENS_BOOTSTRAP = Bun.env.ENS_BOOTSTRAP !== '0';
const AGENT_ENS_NAME = `watcher-sourcify.agents.${ENS_ROOT}`;

function parseTargets(env: string): WatchTarget[] {
  // Format: "<chainId>:<address>[:<label>]" comma-separated
  return env
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(':');
      const chainId = Number(parts[0]);
      const address = parts[1];
      const label = parts[2];
      if (!Number.isFinite(chainId) || !address) {
        throw new Error(`bad target: ${entry}`);
      }
      const target: WatchTarget = { chainId, address: address.toLowerCase() };
      if (label) target.label = label;
      return target;
    });
}

/** Try to read agent config from ENS text records. Returns partial config —
 *  caller merges with env-var defaults. */
async function loadEnsConfig(): Promise<Partial<{
  signalApi: string;
  submitter: string;
  reputation: number;
}>> {
  const rpcUrl = Bun.env.SEPOLIA_RPC_URL ?? Bun.env.RPC_URL;
  if (!rpcUrl) {
    console.warn('[watcher] no RPC_URL for ENS bootstrap — using env vars only');
    return {};
  }
  try {
    const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
    const [signalApi, submitter, reputationStr] = await Promise.all([
      client.getEnsText({ name: AGENT_ENS_NAME, key: 'signal_api' }),
      client.getEnsText({ name: AGENT_ENS_NAME, key: 'submitter' }),
      client.getEnsText({ name: AGENT_ENS_NAME, key: 'reputation' }),
    ]);
    const out: Partial<{ signalApi: string; submitter: string; reputation: number }> = {};
    if (signalApi) out.signalApi = signalApi;
    if (submitter) out.submitter = submitter;
    if (reputationStr) out.reputation = Number(reputationStr);
    if (Object.keys(out).length > 0) {
      console.log(`[watcher] ENS config loaded from ${AGENT_ENS_NAME}:`);
      if (out.signalApi) console.log(`  signal_api  = ${out.signalApi}`);
      if (out.submitter) console.log(`  submitter   = ${out.submitter}`);
      if (out.reputation) console.log(`  reputation  = ${out.reputation}`);
    } else {
      console.log(`[watcher] ${AGENT_ENS_NAME}: no text records found — using env vars`);
    }
    return out;
  } catch (e) {
    console.warn(`[watcher] ENS bootstrap failed (${(e as Error).message}) — using env vars`);
    return {};
  }
}

async function main(): Promise<void> {
  const targetsEnv = Bun.env.WATCHER_TARGETS;
  if (!targetsEnv) {
    throw new Error(
      'set WATCHER_TARGETS — comma-separated <chainId>:<address>[:<label>]',
    );
  }

  // --- ENS bootstrap ---
  const ensConfig = ENS_BOOTSTRAP ? await loadEnsConfig() : {};

  const config = {
    targets: parseTargets(targetsEnv),
    signalApi: ensConfig.signalApi ?? Bun.env.ARGUS_API ?? 'http://127.0.0.1:8787',
    submitter: ensConfig.submitter ?? Bun.env.WATCHER_SUBMITTER ?? AGENT_ENS_NAME,
    reputation: ensConfig.reputation ?? Number(Bun.env.WATCHER_REPUTATION ?? 90),
    pollMs: Number(Bun.env.WATCHER_POLL_MS ?? 30_000),
  };

  const sourcifyOpts: SourcifyHttpOptions = {};
  if (Bun.env.SOURCIFY_BASE_URL) sourcifyOpts.baseUrl = Bun.env.SOURCIFY_BASE_URL;
  const sourcify = new SourcifyHttp(sourcifyOpts);

  console.log('[watcher] identity    ', AGENT_ENS_NAME);
  console.log('[watcher] submitter   ', config.submitter);
  console.log('[watcher] signal-api  ', config.signalApi);
  console.log('[watcher] reputation  ', config.reputation);
  console.log('[watcher] targets     ');
  for (const t of config.targets) {
    console.log(`  - ${t.chainId}:${t.address}${t.label ? ` (${t.label})` : ''}`);
  }
  console.log('[watcher] poll        ', config.pollMs, 'ms');

  const w = new Watcher(config, sourcify);
  w.start();
  await new Promise(() => {});
}

await main();
