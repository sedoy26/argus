// Watcher entrypoint. Boots from env vars and runs forever.

import { SourcifyHttp, type SourcifyHttpOptions } from './sourcify.ts';
import { Watcher, type WatchTarget } from './watcher.ts';

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

async function main(): Promise<void> {
  const targetsEnv = Bun.env.WATCHER_TARGETS;
  if (!targetsEnv) {
    throw new Error(
      'set WATCHER_TARGETS — comma-separated <chainId>:<address>[:<label>]',
    );
  }
  const config = {
    targets: parseTargets(targetsEnv),
    signalApi: Bun.env.ARGUS_API ?? 'http://127.0.0.1:8787',
    submitter: Bun.env.WATCHER_SUBMITTER ?? 'watcher-sourcify.argus.eth',
    reputation: Number(Bun.env.WATCHER_REPUTATION ?? 90),
    pollMs: Number(Bun.env.WATCHER_POLL_MS ?? 30_000),
  };
  const sourcifyOpts: SourcifyHttpOptions = {};
  if (Bun.env.SOURCIFY_BASE_URL) sourcifyOpts.baseUrl = Bun.env.SOURCIFY_BASE_URL;
  const sourcify = new SourcifyHttp(sourcifyOpts);

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
