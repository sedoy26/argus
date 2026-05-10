#!/usr/bin/env bun
// Apify demo trigger — the "provider posts about vulnerability" moment.
//
// DEMO NARRATIVE:
//   1. A security researcher tweets about FakeSwapNet's arbitrary-call vuln
//   2. Argus's Apify scout pays for real tweet data via X402 or token
//   3. extract() mines the tweet → UNCONFIRMED signal submitted to TEE
//   4. Sourcify + on-chain watchers add CONFIRMED signals
//   5. TEE hits CRITICAL → guardian triggers → dashboard shows it live
//
// ─── TRANSPORT MODES (priority order) ─────────────────────────────────────
//
//  X402  set APIFY_X402_PRIVATE_KEY
//    Full on-chain: 402 → sign ERC-3009 TransferWithAuthorization (EIP-712) →
//    pay USDC on Base mainnet → Apify settles & runs actor. No account needed.
//    Wallet must have USDC on Base (0x833589…). Min $1/run.
//
//  TOKEN  set APIFY_TOKEN
//    Bearer auth. Real Apify API call. Scrapes the TWITTER_HANDLE timeline
//    (no Twitter cookies needed for user timeline mode), or falls back to
//    pushing scripted items to a dataset.
//    Token: https://console.apify.com/settings/integrations
//
//  MOCK  (no credentials)
//    Pre-scripted items, fully local. Good for rehearsal.
//
// ─── ENV ──────────────────────────────────────────────────────────────────
//  APIFY_X402_PRIVATE_KEY   hex private key (USDC on Base wallet)   preferred
//  APIFY_TOKEN              Apify API token                          fallback
//  TWITTER_HANDLE           handle to scrape (no @)      default: argus_demo
//  ARGUS_API                signal-api URL               default: :8788
//  SCOUT_CHAIN_ID                                        default: 11155111
//  TARGET_CONTRACT                                       default: FakeSwapNet Sepolia
//
// ─── REAL DEMO SETUP ──────────────────────────────────────────────────────
// 1. Tweet from your account (or any account set in TWITTER_HANDLE):
//      "🚨 FakeSwapNet 0x3b38fe80891ec608829e941ef965e1c96d3460d6
//       arbitrary call vulnerability — execute() drains user approvals
//       #DeFiSecurity #Web3"
// 2. Run: APIFY_TOKEN=apify_api_xxx TWITTER_HANDLE=youraccount bun run demo
// 3. Watch the signal appear on the dashboard at localhost:5173

import { type FeedItem } from '../src/feed.ts';
import { Scout } from '../src/scout.ts';
import { fetchWithX402 } from '../src/x402.ts';

const SIGNAL_API = Bun.env.ARGUS_API ?? 'http://127.0.0.1:8788';
const APIFY_TOKEN = Bun.env.APIFY_TOKEN;
const X402_KEY = Bun.env.APIFY_X402_PRIVATE_KEY as `0x${string}` | undefined;
// Optional: paste the URL of a specific tweet to scrape it directly (no auth needed).
// Useful when the researcher's account is too new to be in Apify's index.
const TWEET_URL = Bun.env.TWEET_URL;
const CHAIN_ID = Number(Bun.env.SCOUT_CHAIN_ID ?? 11155111);
const TARGET = (Bun.env.TARGET_CONTRACT ?? '0x3b38fe80891ec608829e941ef965e1c96d3460d6').toLowerCase();
const TWITTER_HANDLE = Bun.env.TWITTER_HANDLE ?? 'cryptoham42';
const APIFY_BASE = 'https://api.apify.com/v2';

// Primary actor: apidojo/tweet-scraper — real-time, no caching, no cookies.
// Supports twitterHandles[] for user timeline and searchTerms[] for keyword search.
// Cost: similar Pay Per Event pricing, X402 compatible.
const ACTOR_ID = 'apidojo/tweet-scraper';
const ACTOR_SLUG = 'apidojo~tweet-scraper';

// Scripted fallback tweets — use @FakeSwapNet handle (no 0x address needed!)
// to demonstrate the project-mention resolver: handle → ENS → contract address.
const SCRIPTED_ITEMS: FeedItem[] = [
  {
    id: `cryptoham42/${TARGET.slice(2, 10)}-demo`,
    source: 'apify:mock:cryptoham42',
    author: 'cryptoham42',
    url: `https://x.com/cryptoham42/status/fakeswapnet-demo`,
    ts: Math.floor(Date.now() / 1000),
    text: `🚨 @FakeSwapNet has an arbitrary call vulnerability — execute() can drain all user approvals. Holders at risk. REVOKE NOW! #DeFiSecurity #Web3Security`,
  },
  {
    id: `cryptoham42/${TARGET.slice(2, 10)}-followup`,
    source: 'apify:mock:cryptoham42',
    author: 'cryptoham42',
    ts: Math.floor(Date.now() / 1000) + 60,
    text: `Update on @FakeSwapNet exploit: execute(address,bytes) is an unguarded external call — classic approval drain. No access control whatsoever. #DeFiSecurity`,
  },
];

// ---------------------------------------------------------------------------
// Apify helpers
// ---------------------------------------------------------------------------

async function apifyFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${APIFY_BASE}${path}`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init?.headers as Record<string, string>),
  };
  if (APIFY_TOKEN) headers['authorization'] = `Bearer ${APIFY_TOKEN}`;
  return fetch(url, { ...init, headers });
}

/** Run apidojo/tweet-scraper with arbitrary input and return raw rows. */
async function apidojoRun(input: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const url = `${APIFY_BASE}/acts/${ACTOR_SLUG}/run-sync-get-dataset-items?clean=1`;
  let res: Response;
  if (X402_KEY) {
    console.log(`[x402] paying for ${ACTOR_ID} run (USDC on Base)…`);
    const { response } = await fetchWithX402(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }, X402_KEY);
    res = response;
  } else {
    res = await apifyFetch(`/acts/${ACTOR_SLUG}/run-sync-get-dataset-items?clean=1`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  if (!res.ok) throw new Error(`Apify actor ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Array<Record<string, unknown>>;
}

function rowToFeedItem(row: Record<string, unknown>, handle: string): FeedItem {
  const authorObj = typeof row['author'] === 'object' && row['author'] !== null
    ? (row['author'] as Record<string, unknown>)
    : {};
  const author = typeof authorObj['userName'] === 'string' ? authorObj['userName'] : handle;
  return {
    id: String(row['id'] ?? 'apify-' + Math.random().toString(36).slice(2, 10)),
    source: `apify:${ACTOR_ID}:@${handle}`,
    author,
    url: typeof row['url'] === 'string' ? row['url'] : `https://x.com/${handle}/status/${String(row['id'] ?? '')}`,
    ts: typeof row['createdAt'] === 'string'
      ? Math.floor(Date.parse(row['createdAt'] as string) / 1000)
      : undefined,
    text: String(row['text'] ?? ''),
  };
}

/** Scrape a user's timeline with apidojo/tweet-scraper (real-time, no caching). */
async function scrapeUserTimeline(handle: string): Promise<FeedItem[]> {
  const actorPath = `/acts/automation-lab~twitter-scraper/run-sync-get-dataset-items?clean=1`;

  // 1. If a specific tweet URL is provided, scrape it directly (works for any public tweet,
  //    even from brand-new accounts — no auth needed, no indexing requirement).
  if (TWEET_URL) {
    console.log(`[apify] scraping specific tweet URL: ${TWEET_URL}`);
    const res = await apifyFetch(actorPath, {
      method: 'POST',
      body: JSON.stringify({ startUrls: [TWEET_URL], mode: 'tweets', maxItems: 5 }),
    });
    if (res.ok) {
      const rows = (await res.json()) as Array<Record<string, unknown>>;
      const valid = rows.filter((r) => typeof r['text'] === 'string' && (r['text'] as string).length > 0);
      console.log(`[apify] startUrls: ${valid.length} valid tweets`);
      if (valid.length > 0) {
        console.log(`[apify] tweet: ${String(valid[0]!['text']).slice(0, 80)}`);
        return valid.map((r) => rowToFeedItem(r, handle));
      }
    }
  }

  // 2. user-tweets mode — works for established/indexed accounts (PeckShield, samczsun, etc.)
  //    New or small accounts may return 0 and fall through to scripted.
  console.log(`[apify] user-tweets mode for @${handle}`);
  const res2 = await apifyFetch(actorPath, {
    method: 'POST',
    body: JSON.stringify({ usernames: [handle], maxItems: 30, mode: 'user-tweets' }),
  });
  if (res2.ok) {
    const rows = (await res2.json()) as Array<Record<string, unknown>>;
    const valid = rows.filter((r) => typeof r['text'] === 'string' && (r['text'] as string).length > 0);
    console.log(`[apify] user-tweets: ${rows.length} rows, ${valid.length} valid for @${handle}`);
    if (valid.length > 0) {
      console.log(`[apify] sample: ${String(valid[0]!['text']).slice(0, 80)}`);
      return valid.map((r) => rowToFeedItem(r, handle));
    }
  }

  console.log(`[apify] no results from real scraper — will use scripted fallback`);
  return [];
}

/** Push scripted items to an Apify dataset and read them back (token mode). */
async function datasetRoundtrip(): Promise<FeedItem[]> {
  const crRes = await apifyFetch('/datasets?name=argus-demo-security-feed', { method: 'POST' });
  const cr = (await crRes.json()) as { data: { id: string } };
  const dsId = cr.data.id;
  console.log(`[apify] dataset ${dsId}`);
  await apifyFetch(`/datasets/${dsId}/items`, {
    method: 'POST',
    body: JSON.stringify(SCRIPTED_ITEMS.map((i) => ({
      id: i.id,
      text: i.text,
      author: i.author,
      createdAt: i.ts ? new Date(i.ts * 1000).toISOString() : new Date().toISOString(),
      url: i.url,
      source: i.source,
    }))),
  });
  const getRes = await apifyFetch(`/datasets/${dsId}/items?clean=1`);
  const rows = (await getRes.json()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r['id'] ?? ''),
    source: String(r['source'] ?? `apify:dataset`),
    author: typeof r['author'] === 'string' ? r['author'] : undefined,
    url: typeof r['url'] === 'string' ? r['url'] : undefined,
    ts: typeof r['createdAt'] === 'string' ? Math.floor(Date.parse(r['createdAt'] as string) / 1000) : undefined,
    text: String(r['text'] ?? ''),
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const mode = X402_KEY ? 'X402 (USDC on Base mainnet)' : APIFY_TOKEN ? `TOKEN (bearer, actor: ${ACTOR_ID})` : 'MOCK (no credentials)';

  console.log();
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           ARGUS APIFY SCOUT — DEMO TRIGGER              ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  target   ${TARGET}`);
  console.log(`  chain    Sepolia (${CHAIN_ID})`);
  console.log(`  api      ${SIGNAL_API}`);
  console.log(`  mode     ${mode}`);
  if (APIFY_TOKEN) console.log(`  handle   @${TWITTER_HANDLE}`);
  console.log();

  // Preflight
  const health = (await (await fetch(`${SIGNAL_API}/health`)).json()) as { status: string };
  if (health.status !== 'ok') console.warn(`  ⚠ signal-api status=${health.status}`);
  else console.log(`  ✓ signal-api reachable`);

  // ─── Fetch security alert from Apify ─────────────────────────────────────
  console.log();
  console.log('─── STEP 1: security researcher posts about vulnerability ───');
  console.log();

  let feedItems: FeedItem[];

  if (X402_KEY) {
    // Full X402 payment path
    console.log('  Paying for real tweet data with USDC on Base (ERC-3009 + EIP-712)…');
    try {
      feedItems = await scrapeUserTimeline(TWITTER_HANDLE);
      const relevant = feedItems.filter((i) =>
        i.text.toLowerCase().includes(TARGET.toLowerCase().slice(0, 10)) ||
        i.text.toLowerCase().includes('arbitrary call') ||
        i.text.toLowerCase().includes('vulnerability') ||
        i.text.toLowerCase().includes('exploit'),
      );
      if (relevant.length > 0) {
        console.log(`  ✓ Found ${relevant.length} relevant tweet(s) from @${TWITTER_HANDLE}`);
        feedItems = relevant;
      } else {
        console.log(`  No matching tweets found in @${TWITTER_HANDLE} timeline → using scripted alert`);
        feedItems = SCRIPTED_ITEMS;
      }
    } catch (err) {
      console.warn(`  X402 actor failed: ${(err as Error).message.slice(0, 80)}`);
      console.log('  Falling back to scripted items for demo resilience');
      feedItems = SCRIPTED_ITEMS;
    }
  } else if (APIFY_TOKEN) {
    // Token path: real-time scrape via apidojo/tweet-scraper
    try {
      console.log(`  Scraping @${TWITTER_HANDLE} timeline via ${ACTOR_ID}…`);
      feedItems = await scrapeUserTimeline(TWITTER_HANDLE);
      // Log all retrieved tweets so operator can see what was fetched
      if (feedItems.length > 0) {
        console.log(`  Retrieved tweets from @${TWITTER_HANDLE}:`);
        for (const t of feedItems.slice(0, 5)) {
          console.log(`    · ${t.text.slice(0, 100)}${t.text.length > 100 ? '…' : ''}`);
        }
      }
      const relevant = feedItems.filter((i) => {
        const t = i.text.toLowerCase();
        return (
          t.includes(TARGET.slice(2, 12)) ||       // contract address prefix
          t.includes('arbitrary call') ||
          t.includes('vulnerability') ||
          t.includes('exploit') ||
          t.includes('fakeswap') ||                 // catches @FakeSwapNet, fakeswapnet
          t.includes('drain') ||
          t.includes('revoke')
        );
      });
      if (relevant.length > 0) {
        console.log(`  ✓ Found ${relevant.length} relevant tweet(s) from @${TWITTER_HANDLE}`);
        feedItems = relevant;
      } else {
        console.log(`  No matching tweets in @${TWITTER_HANDLE} — pushing scripted alert to Apify dataset…`);
        feedItems = await datasetRoundtrip();
        console.log(`  ✓ Read ${feedItems.length} items back from Apify dataset`);
      }
    } catch (err) {
      console.warn(`  Actor run failed: ${(err as Error).message.slice(0, 80)}`);
      console.log('  Using scripted items');
      feedItems = SCRIPTED_ITEMS;
    }
  } else {
    console.log('  [MOCK] using pre-scripted security alert (no Apify credentials)');
    feedItems = SCRIPTED_ITEMS;
  }

  // Show the tweets
  console.log();
  for (const item of feedItems.slice(0, 3)) {
    const excerpt = item.text.length > 130 ? item.text.slice(0, 130) + '…' : item.text;
    console.log(`  @${item.author ?? 'unknown'}:`);
    console.log(`  "${excerpt}"`);
    console.log();
  }

  // ─── Scout extracts + submits signals ────────────────────────────────────
  console.log('─── STEP 2: scout mines tweets → submits signals to TEE ─────');
  console.log();

  const scout = new Scout({
    feed: { fetchLatest: async () => feedItems },
    signalApi: SIGNAL_API,
    submitter: 'scout-apify.agents.argus-security.eth',
    maxReputation: 80,
    chainId: CHAIN_ID,
    verdict: 'UNCONFIRMED',
    pollMs: 0,
  });

  const results = await scout.runOnce();
  if (results.length === 0) {
    console.log('  ⚠ no extractable signals');
    console.log('  hint: make sure tweet contains address + threat keyword');
    console.log(`  keywords: "arbitrary call", "approval drain", "exploit", "drained", etc.`);
  }
  for (const r of results) {
    const b = r.body as { threatType?: string; contractAddress?: string; verdict?: string };
    if (r.ok) {
      console.log(`  ✓ ${String(b.threatType)} on ${String(b.contractAddress ?? '').slice(0, 10)}… [${String(b.verdict)}] → score=${r.consensus?.score ?? '?'}`);
    } else {
      console.log(`  ✗ failed: ${r.error ?? r.status}`);
    }
  }

  // ─── Current consensus ────────────────────────────────────────────────────
  console.log();
  console.log('─── STEP 3: TEE consensus ───────────────────────────────────');
  console.log();
  const risk = (await (await fetch(`${SIGNAL_API}/risk/${TARGET}`)).json()) as {
    score: string; confirmed: number; count: number; summary?: string; attestation?: string;
  };
  console.log(`  score      ${risk.score}`);
  console.log(`  signals    ${risk.confirmed} confirmed / ${risk.count} total`);
  console.log(`  summary    ${risk.summary ?? '—'}`);
  console.log(`  attest     ${(risk.attestation ?? '').slice(0, 18)}…`);

  console.log();
  console.log('─────────────────────────────────────────────────────────────');
  console.log('  Next steps for full demo:');
  console.log('  1. Submit CONFIRMED signals from Sourcify + on-chain watchers');
  console.log('  2. TEE escalates to CRITICAL → guardian triggers');
  console.log(`  3. Watch it live: http://localhost:5173`);
  console.log('     (or run: cd scripts && bun run demo-sepolia for full flow)');
  console.log();

  if (APIFY_TOKEN && TWITTER_HANDLE === 'argus_demo') {
    console.log('  TIP: tweet from your own account and set TWITTER_HANDLE to see');
    console.log('       real tweets get picked up by the scout!');
    console.log();
  }
}

await main();
