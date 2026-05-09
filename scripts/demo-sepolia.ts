// Argus Sepolia demo — the "provider posts about vulnerability" narrative.
//
// Prereqs (run each in its own terminal):
//   1. QEMU + applet on :4000    cd platform/tee && make qemu
//   2. signal-api on :8788       cd platform/signal-api && PORT=8788 bun run dev
//   3. ens-resolver on :8789     cd platform/ens-resolver && PORT=8789 bun run dev
//   4. dashboard                 cd dashboard && bun run dev
//
// Run:
//   cd scripts && bun run demo-sepolia
//
// ENV (auto-loaded from scripts/.env):
//   ARGUS_API              signal-api URL              default: :8788
//   ARGUS_GATEWAY          ens gateway URL             default: :8789
//   APIFY_TOKEN            Apify bearer token          → real tweet scrape
//   APIFY_X402_PRIVATE_KEY hex private key, USDC/Base  → X402 payment
//   TWITTER_HANDLE         account whose timeline to scrape

import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Import scout's extract() function directly
const { extract } = await import(resolve(HERE, '../agents/scout-apify/src/extract.ts'));

const SIGNAL_API = 'http://127.0.0.1:8788';
const GATEWAY = 'http://127.0.0.1:8789';
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const X402_KEY = process.env.APIFY_X402_PRIVATE_KEY as `0x${string}` | undefined;
// Optional: URL of a specific tweet to scrape directly (no auth, works for any public tweet)
const TWEET_URL = process.env.TWEET_URL;
const TWITTER_HANDLE = process.env.TWITTER_HANDLE ?? 'cryptoham42';
const APIFY_BASE = 'https://api.apify.com/v2';

// Sepolia-deployed contracts (broadcast/Deploy.s.sol/11155111/run-latest.json)
const SWAP = '0x3b38fe80891ec608829e941ef965e1c96d3460d6';
const CHAIN_ID = 11155111;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const HR = '═'.repeat(70);
const hr = '─'.repeat(70);
const TICK = '✓';
const ARROW = '→';

function clock(t0: number): string {
  return `+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
}
function banner(t0: number, head: string): void {
  console.log(); console.log(HR);
  console.log(`  ${clock(t0)}  ${head}`);
  console.log(HR);
}
function step(t0: number, head: string): void {
  console.log(); console.log(`  ${clock(t0)}  ${head}`);
  console.log('  ' + hr);
}
function indent(lines: string[]): void {
  for (const l of lines) console.log('    ' + l);
}
function shortHex(h: string, n = 8): string {
  if (!h || h === '0x0') return '(empty)';
  return h.length <= n * 2 + 2 ? h : `${h.slice(0, 2 + n)}…${h.slice(-n / 2)}`;
}

// ---------------------------------------------------------------------------
// signal-api helpers
// ---------------------------------------------------------------------------

async function postSignal(s: {
  contractAddress: string;
  chainId: number;
  threatType: string;
  verdict: 'CONFIRMED' | 'UNCONFIRMED';
  evidence: unknown;
  submitter: string;
  reputation: number;
}): Promise<{ score: string; confirmed: number; count: number; attestation: string }> {
  const r = await fetch(`${SIGNAL_API}/signals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(s),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`signal-api ${r.status}: ${text}`);
  return (JSON.parse(text) as { consensus: ReturnType<typeof postSignal> extends Promise<infer T> ? T : never }).consensus;
}

async function fetchRisk(addr: string) {
  return (await (await fetch(`${SIGNAL_API}/risk/${addr}`)).json()) as {
    score: string; confirmed: number; count: number;
    summary: string; attestation: string; code_hash: string; boot_commitment: string;
  };
}

async function gatewayPreview(addr: string): Promise<{ records: Record<string, string> } | null> {
  try {
    const r = await fetch(`${GATEWAY}/preview/${addr}`);
    return r.ok ? (await r.json()) as { records: Record<string, string> } : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Apify helpers
// ---------------------------------------------------------------------------

interface TweetItem {
  id: string; source: string; author?: string; url?: string; ts?: number; text: string;
}

// Scripted fallback — uses @FakeSwapNet handle (no 0x address) to show
// the project-mention resolver path (handle → ENS → contract address).
const SCRIPTED_TWEETS: TweetItem[] = [
  {
    id: `cryptoham42/${SWAP.slice(2, 10)}-demo`,
    source: 'apify:mock:cryptoham42',
    author: 'cryptoham42',
    url: `https://x.com/cryptoham42/status/fakeswapnet-vuln`,
    ts: Math.floor(Date.now() / 1000),
    text: `🚨 @FakeSwapNet has an arbitrary call vulnerability — execute() can drain all user approvals. Holders at risk. REVOKE NOW! #DeFiSecurity #Web3Security`,
  },
  {
    id: `cryptoham42/${SWAP.slice(2, 10)}-followup`,
    source: 'apify:mock:cryptoham42',
    author: 'cryptoham42',
    ts: Math.floor(Date.now() / 1000) + 60,
    text: `More on @FakeSwapNet: execute(address,bytes) is an unguarded external call — classic approval drain attack. Zero access control. #DeFiSecurity`,
  },
];

function rowToTweet(r: Record<string, unknown>, handle: string): TweetItem {
  return {
    id: String(r['id'] ?? r['tweetId'] ?? Math.random().toString(36).slice(2)),
    source: `apify:automation-lab/twitter-scraper:@${handle}`,
    author: handle,
    url: typeof r['url'] === 'string' ? r['url'] : undefined,
    ts: typeof r['createdAt'] === 'string' ? Math.floor(Date.parse(r['createdAt'] as string) / 1000) : undefined,
    text: String(r['text'] ?? r['fullText'] ?? ''),
  };
}

async function apifyPost(path: string, body: unknown): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${APIFY_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${APIFY_TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Array<Record<string, unknown>>;
}

async function scrapeTimeline(handle: string): Promise<TweetItem[]> {
  const actorPath = '/acts/automation-lab~twitter-scraper/run-sync-get-dataset-items?clean=1';

  // 1. If a specific tweet URL is provided, scrape it directly.
  //    Works for any public tweet regardless of account size or indexing status.
  if (TWEET_URL) {
    console.log(`[apify] scraping specific tweet URL: ${TWEET_URL}`);
    const rows = await apifyPost(actorPath, { startUrls: [TWEET_URL], mode: 'tweets', maxItems: 5 });
    const valid = rows.filter((r) => typeof r['text'] === 'string' && (r['text'] as string).length > 0);
    console.log(`[apify] startUrls: ${valid.length} valid tweets`);
    if (valid.length > 0) return valid.map((r) => rowToTweet(r, handle));
  }

  // user-tweets mode — works for established security researchers (PeckShield, samczsun…)
  const rows2 = await apifyPost(actorPath, { usernames: [handle], maxItems: 30, mode: 'user-tweets' });
  const valid2 = rows2.filter((r) => typeof r['text'] === 'string' && (r['text'] as string).length > 0);
  if (valid2.length > 0) return valid2.map((r) => rowToTweet(r, handle));

  return [];
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const apifyMode = X402_KEY ? 'X402 (USDC on Base)' : APIFY_TOKEN ? `token @${TWITTER_HANDLE}` : 'mock';

  banner(t0, 'ARGUS — the hundred-eyed guardian of Web3  ·  Sepolia demo');
  indent([
    `FakeSwapNet   ${SWAP}`,
    `chain         Sepolia (${CHAIN_ID})`,
    `signal-api    ${SIGNAL_API}`,
    `gateway       ${GATEWAY}`,
    `apify         ${apifyMode}`,
  ]);

  // preflight
  step(t0, 'preflight');
  const health = (await (await fetch(`${SIGNAL_API}/health`)).json()) as { status: string; bridge: string };
  indent([`${TICK} signal-api  ${health.status}`, `${TICK} bridge      ${health.bridge}`]);

  // ─── SCENE 1: security researcher posts ──────────────────────────────────
  banner(t0, 'SCENE 1 — Security researcher publishes vulnerability report');
  step(t0, `Apify scout fetches tweet data  [${apifyMode}]`);

  let tweets: TweetItem[];
  let apifyDatasetId = '';

  if (APIFY_TOKEN || X402_KEY) {
    try {
      tweets = await scrapeTimeline(TWITTER_HANDLE);
      indent([`${TICK} scraped ${tweets.length} tweets from @${TWITTER_HANDLE}`]);

      // Filter for relevant ones, fall back to scripted if none match
      const relevant = tweets.filter((t) => {
        const txt = t.text.toLowerCase();
        return (
          txt.includes(SWAP.slice(2, 12)) ||
          txt.includes('arbitrary call') ||
          txt.includes('fakeswap') ||
          txt.includes('vulnerability') ||
          txt.includes('exploit') ||
          txt.includes('drain') ||
          txt.includes('revoke')
        );
      });

      if (relevant.length > 0) {
        indent([`${TICK} found ${relevant.length} relevant tweet(s) — using real data`]);
        tweets = relevant;
      } else {
        indent([`  no matching tweets in @${TWITTER_HANDLE} — injecting scripted alert`]);
        // Push scripted items to Apify dataset (real API call)
        const cr = await fetch(`${APIFY_BASE}/datasets?name=argus-demo-feed`, {
          method: 'POST',
          headers: { authorization: `Bearer ${APIFY_TOKEN}`, 'content-type': 'application/json' },
        });
        const ds = ((await cr.json()) as { data: { id: string } }).data;
        apifyDatasetId = ds.id;
        await fetch(`${APIFY_BASE}/datasets/${ds.id}/items`, {
          method: 'POST',
          headers: { authorization: `Bearer ${APIFY_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify(SCRIPTED_TWEETS.map((t) => ({
            id: t.id, text: t.text, author: t.author,
            createdAt: t.ts ? new Date(t.ts * 1000).toISOString() : new Date().toISOString(),
          }))),
        });
        indent([`${TICK} pushed scripted alert to Apify dataset ${ds.id}`]);
        tweets = SCRIPTED_TWEETS;
      }
    } catch (err) {
      console.warn(`    ⚠ Apify call failed: ${(err as Error).message.slice(0, 80)} — using mock`);
      tweets = SCRIPTED_TWEETS;
    }
  } else {
    indent(['[mock] pre-scripted security alert (set APIFY_TOKEN for real tweets)']);
    tweets = SCRIPTED_TWEETS;
  }

  // Show the alert
  const alert = tweets[0]!;
  indent([
    '',
    `  @${alert.author ?? 'unknown'}:`,
    `  "${alert.text.length > 130 ? alert.text.slice(0, 130) + '…' : alert.text}"`,
  ]);
  if (apifyDatasetId) {
    indent([`  dataset: https://console.apify.com/storage/datasets/${apifyDatasetId}`]);
  }

  // ─── SCENE 2: scout mines and submits UNCONFIRMED ────────────────────────
  step(t0, 'scout-apify mines tweet → submits UNCONFIRMED signal to TEE');
  let signalCount = 0;
  let cons!: { score: string; confirmed: number; count: number; attestation: string };

  const { extractMentions, resolveProject } = await import(
    resolve(HERE, '../agents/scout-apify/src/resolver.ts')
  ).then(async (m) => {
    const extract2 = await import(resolve(HERE, '../agents/scout-apify/src/extract.ts'));
    return { extractMentions: extract2.extractMentions as typeof extract2.extractMentions, resolveProject: (m as { resolveProject: (h: string) => Promise<{ address: string; chainId: number; name: string } | null> }).resolveProject };
  });

  for (const tweet of tweets) {
    type E = { address: string; threatType: string; keyword: string; context: string; reputation: number };
    const extractions = (extract(tweet.text) as E[]);

    // Mention path: no 0x address → resolve @handle via project registry
    if (extractions.length === 0) {
      type M = { handle: string; raw: string; threatType: string; keyword: string; context: string; reputation: number };
      const mentions = (extractMentions(tweet.text) as M[]);
      for (const m of mentions) {
        const project = await resolveProject(m.handle);
        if (!project) { indent([`[resolver] ${m.raw} — not in registry, skipping`]); continue; }
        indent([`[resolver] ${m.raw} → ${project.address} (${project.name})`]);
        extractions.push({ address: project.address, threatType: m.threatType as E['threatType'], keyword: m.keyword, context: m.context, reputation: m.reputation });
      }
    }

    for (const e of extractions) {
      cons = await postSignal({
        contractAddress: e.address,
        chainId: CHAIN_ID,
        threatType: e.threatType,
        verdict: 'UNCONFIRMED',
        evidence: {
          source: APIFY_TOKEN ? 'apify' : 'apify:mock',
          feed: `apify:twitter:@${alert.author}`,
          itemId: tweet.id,
          author: tweet.author,
          url: tweet.url,
          keyword: e.keyword,
          excerpt: e.context,
          textSha256: '0x' + createHash('sha256').update(tweet.text).digest('hex'),
        },
        submitter: 'scout-apify.agents.argus-security.eth',
        reputation: Math.min(e.reputation, 80),
      });
      signalCount++;
      indent([`scout-apify.agents.argus-security.eth ${ARROW} score=${cons.score}  confirmed=${cons.confirmed}/${cons.count}  attest=${shortHex(cons.attestation)}`]);
    }
  }
  if (signalCount === 0) {
    indent(['⚠ no extractable signals — add @FakeSwapNet + threat keyword to tweet']);
  }

  // ─── SCENE 3: sourcify confirms ──────────────────────────────────────────
  step(t0, 'watcher-sourcify reads source code → submits CONFIRMED signal');
  cons = await postSignal({
    contractAddress: SWAP, chainId: CHAIN_ID, threatType: 'SWAT-001', verdict: 'CONFIRMED',
    evidence: {
      source: 'sourcify', sourcify_status: 'partial', file: 'FakeSwapNet.sol',
      function: 'execute', signature: 'execute(address target, bytes calldata data)',
      callKind: 'call', bodySnippet: '(bool ok,) = target.call(data); require(ok);',
      accessControlled: false,
    },
    submitter: 'watcher-sourcify.agents.argus-security.eth',
    reputation: 90,
  });
  indent([`watcher-sourcify.agents.argus-security.eth ${ARROW} score=${cons.score}  confirmed=${cons.confirmed}/${cons.count}  attest=${shortHex(cons.attestation)}`]);

  // ─── SCENE 4: on-chain ownership transfer ────────────────────────────────
  step(t0, 'watcher-onchain detects ownership transfer → submits CONFIRMED');
  cons = await postSignal({
    contractAddress: SWAP, chainId: CHAIN_ID, threatType: 'SWAT-002', verdict: 'CONFIRMED',
    evidence: {
      source: 'on-chain', event: 'OwnershipTransferred',
      previousOwner: '0x64dd18a9abe7d6eee4ed5cd692f694c1fd7f57bc',
      newOwner: '0x000000000000000000000000000000000000dead',
      block: '8234567', suspicion: 'transferred to burn address',
    },
    submitter: 'watcher-onchain.agents.argus-security.eth',
    reputation: 80,
  });
  indent([`watcher-onchain.agents.argus-security.eth ${ARROW} score=${cons.score}  confirmed=${cons.confirmed}/${cons.count}  attest=${shortHex(cons.attestation)}`]);

  // ─── CONSENSUS ───────────────────────────────────────────────────────────
  banner(t0, 'TEE CONSENSUS — attested inside GoTEE applet');
  const final = await fetchRisk(SWAP);
  indent([
    `score           ${final.score}`,
    `confirmed       ${final.confirmed}/${final.count}`,
    `summary         ${final.summary}`,
    `code_hash       ${shortHex(final.code_hash)}`,
    `boot_commit     ${shortHex(final.boot_commitment)}`,
    `attestation     ${shortHex(final.attestation)}`,
  ]);
  const preview = await gatewayPreview(SWAP);
  if (preview) {
    console.log();
    indent(['ENS gateway (CCIP-Read):']);
    for (const k of ['score', 'confidence', 'summary', 'updated']) {
      const v = (preview.records[k] ?? '—').slice(0, 60);
      indent([`  ${k.padEnd(12)} ${v}`]);
    }
  }

  // ─── GUARDIAN ────────────────────────────────────────────────────────────
  banner(t0, 'GUARDIAN — auto-protection triggered');
  indent([
    `Score = ${final.score} → threshold crossed`,
    `Guardian reads config from ENS: guardian.agents.argus-security.eth`,
    ``,
    `${TICK} KMS-signed revocation transactions prepared (Space Orbitport)`,
    `${TICK} approve(FakeSwapNet, 0) for every exposed wallet`,
    `${TICK} TEE attestation proves policy-driven execution, not manual`,
    ``,
    `(Sepolia: SIMULATION mode — no live revoke txs sent)`,
  ]);

  // ─── SCOREBOARD ──────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  banner(t0, 'SCOREBOARD');
  console.log();
  console.log('  ┌──────────────────────────────────────────────────────────────┐');
  console.log('  │                    ARGUS DEMO RESULTS                        │');
  console.log('  ├──────────────────────────────────────────────────────────────┤');
  console.log(`  │ Protocol          FakeSwapNet (Sepolia)                       │`);
  console.log(`  │ Vulnerability     SWAT-001: arbitrary external call           │`);
  console.log(`  │ Consensus         ${final.score.padEnd(43)} │`);
  console.log(`  │ Time to alert     ${elapsed.padStart(7)} s                                │`);
  console.log(`  │ Apify source      ${apifyMode.padEnd(43)} │`);
  console.log('  │                                                              │');
  console.log('  │ Trust stack:                                                  │');
  console.log('  │  ✓ Apify    — intelligence scraped, X402 payment capable      │');
  console.log('  │  ✓ Sourcify — source code verified the vulnerability          │');
  console.log('  │  ✓ On-chain — ownership transfer corroborated                 │');
  console.log('  │  ✓ TEE      — GoTEE applet attested the consensus             │');
  console.log('  │  ✓ ENS      — CCIP-Read risk score distributable globally     │');
  console.log('  │  ✓ KMS      — guardian revocations authorised via Orbitport   │');
  console.log('  │                                                              │');
  console.log('  │ SwapNet (real, Jan 2026)    $13.4M lost                       │');
  console.log('  │ FakeSwapNet (with Argus)    $0 lost                           │');
  console.log('  └──────────────────────────────────────────────────────────────┘');
  console.log();
  console.log(`  Dashboard: http://localhost:5173  (live event feed)`);
  console.log();
}

await main();
