// Apify scout smoke — uses MockFeed with simulated security tweets.
//
// We don't hit Apify here: the goal is to validate the extract → scout
// → signal-api pipeline. Hitting Apify+X402 in CI requires real
// credentials and burns demo ETH every run.
//
// Prereqs: signal-api on :8787, applet on :4000.

import { MockFeed, type FeedItem } from '../src/feed.ts';
import { extract } from '../src/extract.ts';
import { Scout } from '../src/scout.ts';

const SIGNAL_API = Bun.env.ARGUS_API ?? 'http://127.0.0.1:8787';
const TARGET_ADDR = '0xcafecafecafecafecafecafecafecafecafecafe';

const FIXED_TWEETS: FeedItem[] = [
  {
    id: 'peckshield/1',
    source: 'twitter:peckshield',
    author: 'PeckShieldAlert',
    url: 'https://twitter.com/PeckShieldAlert/status/example1',
    ts: 1746745001,
    text:
      `[PeckShieldAlert] We've identified an arbitrary call vulnerability in ${TARGET_ADDR} — the execute() function lets any caller drain user funds via approval abuse. Affected: ALL users with active approvals. Recommend revoke immediately.`,
  },
  {
    id: 'samczsun/2',
    source: 'twitter:samczsun',
    author: 'samczsun',
    ts: 1746745300,
    text:
      `Looking at ${TARGET_ADDR}. The execute(address,bytes) signature lets you call transferFrom on any ERC20 the contract has approval over. Classic approval drain attacker pattern.`,
  },
  {
    id: 'random-noise',
    source: 'twitter:random',
    author: 'random_dev',
    ts: 1746745400,
    text:
      `gm — built a new dapp at 0x1234567890123456789012345678901234567890, no vulns, just vibes.`,
  },
];

async function main() {
  console.log('1. extractor unit checks');
  const r1 = extract(FIXED_TWEETS[0]!.text);
  console.log(
    `   tweet 1: ${r1.length} extraction(s) — ${r1.map((e) => `${e.threatType}/${e.keyword}`).join(', ')}`,
  );
  if (r1.length === 0) throw new Error('extract failed on PeckShield tweet');

  const r2 = extract(FIXED_TWEETS[2]!.text);
  console.log(`   tweet 3: ${r2.length} extraction(s) (expect 0 — benign)`);
  if (r2.length !== 0) {
    throw new Error(`benign tweet produced ${r2.length} extractions`);
  }

  console.log('\n2. scout.runOnce() with MockFeed');
  const scout = new Scout({
    feed: new MockFeed(FIXED_TWEETS),
    signalApi: SIGNAL_API,
    submitter: 'scout-apify.argus.eth',
    maxReputation: 75,
    chainId: 1,
    verdict: 'UNCONFIRMED',
    pollMs: 0,
  });
  const subs = await scout.runOnce();
  console.log(`   submissions=${subs.length}`);
  for (const s of subs) {
    if (!s.ok) throw new Error(`submission failed: ${s.error ?? s.status}`);
  }
  if (subs.length < 1) throw new Error('expected at least 1 submission');

  console.log('\n3. dedup — second sweep submits 0');
  const second = await scout.runOnce();
  console.log(`   submissions=${second.length}`);
  if (second.length !== 0) throw new Error('dedup failed');

  console.log('\n4. /risk/:addr reflects scout signal');
  const risk = (await (await fetch(`${SIGNAL_API}/risk/${TARGET_ADDR}`)).json()) as {
    score: string;
    summary: string;
    confirmed: number;
    count: number;
  };
  console.log(`   score=${risk.score} confirmed=${risk.confirmed} count=${risk.count}`);
  console.log(`   summary=${risk.summary}`);
  if (risk.score === 'NONE') throw new Error('signal not registered');
  if (!risk.summary.includes('SWAT-001')) {
    throw new Error('SWAT-001 missing from summary');
  }

  console.log('\nOK');
}

await main();
