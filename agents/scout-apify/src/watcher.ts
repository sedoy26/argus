#!/usr/bin/env bun
//
// Argus live scout watcher — runs continuously, polls for security alerts.
//
// Usage (from repo root):
//   cd agents/scout-apify
//   APIFY_TOKEN=xxx ARGUS_API=http://... bun src/watcher.ts
//
// ENV:
//   APIFY_TOKEN          Apify bearer token
//   ARGUS_API            signal-api URL (default :8788)
//   TWITTER_HANDLE       handle to monitor (default: cryptoham42)
//   TWEET_URL            direct tweet URL to watch (paste after you tweet)
//   POLL_MS              poll interval (default: 30000 ms)
//   SCOUT_CHAIN_ID       Sepolia = 11155111
//   TARGET_CONTRACT      contract address to watch

import { Scout } from './scout.ts';
import type { FeedItem } from './feed.ts';

const SIGNAL_API = Bun.env.ARGUS_API ?? 'http://127.0.0.1:8788';
const APIFY_TOKEN = Bun.env.APIFY_TOKEN ?? '';
const TWITTER_HANDLE = Bun.env.TWITTER_HANDLE ?? 'cryptoham42';
const POLL_MS = Number(Bun.env.POLL_MS ?? 30_000);
const CHAIN_ID = Number(Bun.env.SCOUT_CHAIN_ID ?? 11155111);
const TARGET = (Bun.env.TARGET_CONTRACT ?? '0x3b38fe80891ec608829e941ef965e1c96d3460d6').toLowerCase();
const APIFY_BASE = 'https://api.apify.com/v2';
const ACTOR = 'automation-lab~twitter-scraper';

const seen = new Set<string>();

// ── Apify helpers ────────────────────────────────────────────────────────────

async function apifyPost(input: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const url = `${APIFY_BASE}/acts/${ACTOR}/run-sync-get-dataset-items?clean=1`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${APIFY_TOKEN}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return (await res.json()) as Array<Record<string, unknown>>;
}

function toFeedItem(r: Record<string, unknown>): FeedItem | null {
  const text = String(r['text'] ?? r['fullText'] ?? '');
  if (!text) return null;
  return {
    id: String(r['id'] ?? r['tweetId'] ?? Math.random().toString(36).slice(2)),
    source: `apify:${ACTOR}`,
    author: typeof r['author'] === 'string' ? r['author'] : TWITTER_HANDLE,
    url: typeof r['url'] === 'string' ? r['url'] : undefined,
    ts: typeof r['createdAt'] === 'string' ? Math.floor(Date.parse(r['createdAt'] as string) / 1000) : undefined,
    text,
  };
}

// ── Fetch strategies ─────────────────────────────────────────────────────────

async function fetchByTweetUrl(url: string): Promise<FeedItem[]> {
  const rows = await apifyPost({ startUrls: [url], mode: 'tweets', maxItems: 3 });
  return rows.map(toFeedItem).filter((x): x is FeedItem => x !== null);
}

async function fetchUserTimeline(): Promise<FeedItem[]> {
  const rows = await apifyPost({ usernames: [TWITTER_HANDLE], mode: 'user-tweets', maxItems: 20 });
  return rows
    .map(toFeedItem)
    .filter((x): x is FeedItem => x !== null)
    .filter((x) => !seen.has(x.id));
}

function isRelevant(item: FeedItem): boolean {
  const t = item.text.toLowerCase();
  return (
    t.includes(TARGET.slice(2, 12)) ||
    t.includes('fakeswap') ||
    t.includes('vulnerability') ||
    t.includes('exploit') ||
    t.includes('arbitrary call') ||
    t.includes('drain') ||
    t.includes('revoke')
  );
}

// ── Process batch ────────────────────────────────────────────────────────────

async function processItems(items: FeedItem[]) {
  const relevant = items.filter(isRelevant);
  if (relevant.length === 0) return;

  const newItems = relevant.filter((i) => !seen.has(i.id));
  if (newItems.length === 0) {
    console.log(`  [already processed ${relevant.length} item(s) — skipping]`);
    return;
  }

  for (const item of newItems) seen.add(item.id);

  console.log(`\n  ✦ Found ${newItems.length} relevant tweet(s)!`);
  for (const item of newItems) {
    console.log(`    @${item.author ?? TWITTER_HANDLE}: ${item.text.slice(0, 100)}${item.text.length > 100 ? '…' : ''}`);
  }

  // Create a Scout instance with this batch as the feed
  const scout = new Scout({
    feed: { fetchLatest: async () => newItems },
    signalApi: SIGNAL_API,
    submitter: 'scout-apify.agents.argus-security.eth',
    maxReputation: 80,
    chainId: CHAIN_ID,
    verdict: 'UNCONFIRMED',
    pollMs: 0,
  });

  const results = await scout.runOnce();
  for (const r of results) {
    const b = r.body as { threatType?: string; contractAddress?: string };
    if (r.ok) {
      console.log(`  ✓ ${String(b.threatType)} on ${String(b.contractAddress ?? '').slice(0, 10)}… → score=${r.consensus?.score ?? '?'}`);
    } else {
      console.log(`  ✗ failed: ${r.error ?? r.status}`);
    }
  }
  console.log(`\n  → Dashboard: http://localhost:5173`);
}

// ── Main poll loop ───────────────────────────────────────────────────────────

const TWEET_URL = Bun.env.TWEET_URL;

console.log();
console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║          ARGUS SCOUT — LIVE WATCHER                    ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`  watching  @${TWITTER_HANDLE}`);
console.log(`  target    ${TARGET}`);
console.log(`  api       ${SIGNAL_API}`);
console.log(`  poll      every ${POLL_MS / 1000}s`);
if (TWEET_URL) console.log(`  tweet url ${TWEET_URL}`);
console.log();
console.log('  Waiting for vulnerability tweets… (Ctrl+C to stop)');
console.log();

// Check signal-api
try {
  const h = await fetch(`${SIGNAL_API}/health`).then((r) => r.json()) as { status: string };
  if (h.status === 'ok') console.log('  ✓ signal-api connected\n');
  else console.warn('  ⚠ signal-api status:', h.status);
} catch {
  console.warn('  ⚠ signal-api unreachable — signals will fail\n');
}

let tick = 0;
while (true) {
  tick++;
  const now = new Date().toLocaleTimeString();
  process.stdout.write(`  [${now}] poll #${tick}… `);

  try {
    let items: FeedItem[] = [];

    if (TWEET_URL) {
      // Scrape specific tweet URL directly — works for any public tweet
      items = await fetchByTweetUrl(TWEET_URL);
      process.stdout.write(`tweet url → ${items.length} item(s)\n`);
    } else {
      // Try user timeline (works once account is indexed by Apify)
      items = await fetchUserTimeline();
      process.stdout.write(`@${TWITTER_HANDLE} → ${items.length} tweet(s)\n`);
    }

    await processItems(items);
  } catch (err) {
    process.stdout.write(`error: ${(err as Error).message.slice(0, 60)}\n`);
  }

  await Bun.sleep(POLL_MS);
}
