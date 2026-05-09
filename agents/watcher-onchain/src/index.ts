// On-chain watcher entrypoint.
//
// Boots a viem PublicClient, parses targets from env, and runs the
// poll loop forever.

import { type Address, createPublicClient, http } from 'viem';
import { Watcher, type WatchTarget } from './watcher.ts';

function parseTargets(env: string): WatchTarget[] {
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
        throw new Error(`bad WATCHER_TARGETS entry: ${entry}`);
      }
      const t: WatchTarget = {
        chainId,
        address: address.toLowerCase() as Address,
      };
      if (label) t.label = label;
      return t;
    });
}

async function main(): Promise<void> {
  const targetsEnv = Bun.env.WATCHER_TARGETS;
  if (!targetsEnv) {
    throw new Error(
      'set WATCHER_TARGETS — comma-separated <chainId>:<address>[:<label>]',
    );
  }
  const rpcUrl = Bun.env.RPC_URL ?? 'http://127.0.0.1:8545';
  const client = createPublicClient({ transport: http(rpcUrl) });

  const targets = parseTargets(targetsEnv);
  const w = new Watcher({
    client,
    targets,
    signalApi: Bun.env.ARGUS_API ?? 'http://127.0.0.1:8787',
    submitter: Bun.env.WATCHER_SUBMITTER ?? 'watcher-onchain.argus.eth',
    maxReputation: Number(Bun.env.WATCHER_MAX_REPUTATION ?? 80),
    pollMs: Number(Bun.env.WATCHER_POLL_MS ?? 5000),
  });

  console.log('[watcher-onchain] submitter ', w.config.submitter);
  console.log('[watcher-onchain] signal-api', w.config.signalApi);
  console.log('[watcher-onchain] rpc       ', rpcUrl);
  console.log('[watcher-onchain] targets   ');
  for (const t of targets) {
    console.log(`  - ${t.chainId}:${t.address}${t.label ? ` (${t.label})` : ''}`);
  }
  console.log('[watcher-onchain] poll      ', w.config.pollMs, 'ms');

  w.start();
  await new Promise(() => {});
}

await main();
