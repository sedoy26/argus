// Apify scout entrypoint. Boots from env vars and runs forever.

import { ApifyFeed, type ApifyFeedOptions } from './feed.ts';
import { Scout, type ScoutConfig } from './scout.ts';

function envOrThrow(name: string): string {
  const v = Bun.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

async function main(): Promise<void> {
  const actorId = envOrThrow('APIFY_ACTOR_ID');
  const apifyToken = Bun.env.APIFY_TOKEN;
  // X402: hex private key of a USDC-on-Base-funded wallet
  const x402PrivateKey = Bun.env.APIFY_X402_PRIVATE_KEY as `0x${string}` | undefined;
  if (!apifyToken && !x402PrivateKey) {
    throw new Error(
      'set APIFY_TOKEN (bearer auth) or APIFY_X402_PRIVATE_KEY (x402 payment, USDC on Base)',
    );
  }
  const runInput = JSON.parse(Bun.env.APIFY_RUN_INPUT ?? '{}') as Record<
    string,
    unknown
  >;
  const apifyOpts: ApifyFeedOptions = {
    actorId,
    runInput,
  };
  if (apifyToken) apifyOpts.apifyToken = apifyToken;
  if (x402PrivateKey) apifyOpts.x402PrivateKey = x402PrivateKey;
  if (Bun.env.APIFY_TEXT_FIELD) apifyOpts.textField = Bun.env.APIFY_TEXT_FIELD;
  if (Bun.env.APIFY_ID_FIELD) apifyOpts.idField = Bun.env.APIFY_ID_FIELD;
  if (Bun.env.APIFY_AUTHOR_FIELD) apifyOpts.authorField = Bun.env.APIFY_AUTHOR_FIELD;
  if (Bun.env.APIFY_TS_FIELD) apifyOpts.timestampField = Bun.env.APIFY_TS_FIELD;
  if (Bun.env.APIFY_BASE_URL) apifyOpts.baseUrl = Bun.env.APIFY_BASE_URL;

  const feed = new ApifyFeed(apifyOpts);
  const verdict = (Bun.env.SCOUT_VERDICT ?? 'UNCONFIRMED') as
    | 'CONFIRMED'
    | 'UNCONFIRMED';
  const config: ScoutConfig = {
    feed,
    signalApi: Bun.env.ARGUS_API ?? 'http://127.0.0.1:8787',
    submitter: Bun.env.SCOUT_SUBMITTER ?? 'scout-apify.argus.eth',
    maxReputation: Number(Bun.env.SCOUT_MAX_REPUTATION ?? 75),
    chainId: Number(Bun.env.SCOUT_CHAIN_ID ?? 1),
    verdict,
    pollMs: Number(Bun.env.SCOUT_POLL_MS ?? 60_000),
  };

  console.log('[scout] submitter   ', config.submitter);
  console.log('[scout] signal-api  ', config.signalApi);
  console.log('[scout] actor       ', actorId);
  console.log('[scout] auth        ', apifyToken ? 'bearer token' : 'x402 (USDC on Base)');
  console.log('[scout] chainId     ', config.chainId);
  console.log('[scout] verdict     ', config.verdict);
  console.log('[scout] poll        ', config.pollMs, 'ms');

  const s = new Scout(config);
  s.start();
  await new Promise(() => {});
}

await main();
