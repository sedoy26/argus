// In-memory "social scout agents" — periodic pollers for a trusted profile URL
// (Reddit user or X/Twitter handle). New actionable posts run the same intel
// corroboration as POST /intel. Reddit uses public JSON; X/Twitter uses Apify
// when APIFY_X402_PRIVATE_KEY (X402 / USDC on Base, preferred) or APIFY_TOKEN is set on signal-api.

import { runApifyActorSync } from './apifyActor.ts';
import { emit } from './events.ts';
import type { ConsensusEnvelope } from './signals.ts';

export type IntelCorroborationResult =
  | { error: string }
  | {
      steps: string[];
      contractAddress: string;
      text: string;
      evidence_hash: string;
      consensus: ConsensusEnvelope;
    };

export type RunIntelCorroboration = (
  intelText: string,
  source: string,
  priorSteps: string[],
) => Promise<IntelCorroborationResult>;

export type SocialPlatform = 'reddit' | 'twitter';

export type SocialAgentPublic = {
  id: string;
  profileUrl: string;
  platform: SocialPlatform;
  pollMs: number;
  lastPollAt: number | null;
  lastError: string | null;
  postsProcessed: number;
};

type AgentEntry = SocialAgentPublic & {
  seen: Set<string>;
  timer: ReturnType<typeof setInterval>;
  startedAtSec: number;
  /** Reddit username when platform === 'reddit' */
  redditUser?: string;
  /** Lowercase handle without @ when platform === 'twitter' */
  twitterHandle?: string;
};

const agents = new Map<string, AgentEntry>();
let runIntel: RunIntelCorroboration | null = null;

const APIFY_ACTOR = 'automation-lab~twitter-scraper';

export function registerSocialIntelRunner(fn: RunIntelCorroboration): void {
  runIntel = fn;
}

function intelLooksActionable(text: string, registryKeys: string[]): boolean {
  const x = text.toLowerCase();
  if (/0x[0-9a-f]{40}/.test(x)) return true;
  for (const k of registryKeys) {
    if (x.includes(k.toLowerCase())) return true;
  }
  return ['vulnerability', 'exploit', 'arbitrary call', 'drain', 'revoke', 'fakeswap', 'fake swap'].some((w) =>
    x.includes(w),
  );
}

/** Normalize for dedupe: origin + path, lowercase host. */
function profileKey(profileUrl: string): string {
  try {
    const u = new URL(profileUrl.startsWith('http') ? profileUrl : `https://${profileUrl}`);
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/$/, '').toLowerCase()}`;
  } catch {
    return profileUrl.trim().toLowerCase();
  }
}

export function parseProfileUrl(raw: string): {
  platform: SocialPlatform;
  profileUrl: string;
  redditUser?: string;
  twitterHandle?: string;
} | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const withScheme = trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (host === 'reddit.com' || host === 'old.reddit.com' || host === 'new.reddit.com' || host === 'np.reddit.com') {
      const m = path.match(/^\/(?:user|u)\/([^/?#]+)/i);
      if (!m) return null;
      const user = decodeURIComponent(m[1]!).replace(/^u\//i, '').trim().toLowerCase();
      if (!user || !/^[a-z0-9_-]{2,32}$/i.test(user)) return null;
      return {
        platform: 'reddit',
        profileUrl: `https://www.reddit.com/user/${user}`,
        redditUser: user,
      };
    }

    if (host === 'twitter.com' || host === 'x.com' || host === 'mobile.twitter.com') {
      const parts = path.split('/').filter(Boolean);
      const first = (parts[0] ?? '').replace(/^@/, '');
      const reserved = new Set(['home', 'search', 'settings', 'i', 'intent', 'share', 'hashtag', 'explore', 'messages']);
      if (!first || reserved.has(first.toLowerCase())) return null;
      if (parts.length >= 2 && parts[1]!.toLowerCase() === 'status') return null;
      if (!/^[a-z0-9_]{1,20}$/i.test(first)) return null;
      const handle = first.toLowerCase();
      return {
        platform: 'twitter',
        profileUrl: `https://x.com/${handle}`,
        twitterHandle: handle,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function listSocialAgents(): SocialAgentPublic[] {
  return [...agents.values()].map((a) => ({
    id: a.id,
    profileUrl: a.profileUrl,
    platform: a.platform,
    pollMs: a.pollMs,
    lastPollAt: a.lastPollAt,
    lastError: a.lastError,
    postsProcessed: a.postsProcessed,
  }));
}

export function stopSocialAgent(id: string): boolean {
  const a = agents.get(id);
  if (!a) return false;
  clearInterval(a.timer);
  agents.delete(id);
  emit('info', `Social scout agent stopped`, { id, profileUrl: a.profileUrl });
  return true;
}

/** Stop every poller without per-agent feed lines (batch demo reset). */
export function stopAllSocialAgents(): number {
  let n = 0;
  for (const a of agents.values()) {
    clearInterval(a.timer);
    n++;
  }
  agents.clear();
  return n;
}

function stopAgentsForProfileKey(key: string): void {
  for (const [id, a] of agents) {
    if (profileKey(a.profileUrl) === key) {
      clearInterval(a.timer);
      agents.delete(id);
    }
  }
}

/**
 * Reddit often returns 403 for bare server user-agents or some datacenter IPs.
 * Use browser-like headers; optional `REDDIT_USER_AGENT` on signal-api for operators.
 * Tries www → old → new host (anonymous `.json` endpoints).
 */
export function redditJsonFetchInit(referer: string): RequestInit {
  const ua =
    Bun.env.REDDIT_USER_AGENT?.trim() ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
  return {
    headers: {
      'user-agent': ua,
      accept: 'application/json, text/javascript, */*; q=0.01',
      'accept-language': 'en-US,en;q=0.9',
      referer: referer.startsWith('http') ? referer : `https://www.reddit.com${referer.startsWith('/') ? '' : '/'}${referer}`,
    },
  };
}

export async function fetchRedditUrl(fullUrl: string, referer: string): Promise<Response> {
  const init = redditJsonFetchInit(referer);
  let u: URL;
  try {
    u = new URL(fullUrl);
  } catch {
    return fetch(fullUrl, init);
  }
  if (!/(^|\.)reddit\.com$/i.test(u.hostname)) {
    return fetch(fullUrl, init);
  }

  const pathAndQuery = `${u.pathname}${u.search}`;
  const hosts = ['www.reddit.com', 'old.reddit.com', 'new.reddit.com'] as const;
  let last: Response | null = null;
  for (const host of hosts) {
    const tryUrl = `https://${host}${pathAndQuery}`;
    const r = await fetch(tryUrl, init);
    last = r;
    if (r.ok) return r;
    if (r.status !== 403 && r.status !== 429 && r.status !== 503) return r;
  }
  return last!;
}

async function fetchRedditUserSubmitted(redditUser: string): Promise<Response> {
  const path = `/user/${encodeURIComponent(redditUser)}/submitted.json?limit=25&raw_json=1`;
  const referer = `https://www.reddit.com/user/${encodeURIComponent(redditUser)}/`;
  return fetchRedditUrl(`https://www.reddit.com${path}`, referer);
}

async function apifyUserTweets(handle: string): Promise<Array<Record<string, unknown>>> {
  if (!Bun.env.APIFY_X402_PRIVATE_KEY && !Bun.env.APIFY_TOKEN) {
    throw new Error('Twitter/X watch requires APIFY_X402_PRIVATE_KEY (X402) or APIFY_TOKEN on signal-api');
  }
  const { rows, meta } = await runApifyActorSync(APIFY_ACTOR, {
    usernames: [handle],
    mode: 'user-tweets',
    maxItems: 20,
  });
  if (meta.usedX402) {
    emit('info', 'Scout paid 0.001 ETH via X402 for intelligence ✓', {
      x402: true,
      socialAgent: true,
      x402_usdc: meta.x402UsdcPaid ?? null,
      x402_atomic: meta.x402AtomicAmount ?? null,
      x402_settlement_note:
        'Apify X402 settles in USDC on Base (ERC-3009). Headline uses ETH-sized demo wording for bounty visibility.',
      apifySettlementTx: meta.x402PaymentTx ?? null,
      x402Network: meta.x402Network ?? 'eip155:8453',
    });
  }
  return rows;
}

export function startSocialAgent(
  profileUrlRaw: string,
  pollMsRaw: number,
  registryKeys: string[],
): SocialAgentPublic {
  if (!runIntel) throw new Error('Social intel runner not registered');

  const parsed = parseProfileUrl(profileUrlRaw);
  if (!parsed) {
    throw new Error(
      'unsupported or invalid profile URL — use https://www.reddit.com/user/name or https://x.com/handle',
    );
  }

  const pollMs = Math.max(30_000, Math.min(Number(pollMsRaw) || 120_000, 600_000));
  const pkey = profileKey(parsed.profileUrl);
  stopAgentsForProfileKey(pkey);

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const seen = new Set<string>();
  const startedAtSec = Math.floor(Date.now() / 1000) - 2;

  const row: AgentEntry = {
    id,
    profileUrl: parsed.profileUrl,
    platform: parsed.platform,
    pollMs,
    lastPollAt: null,
    lastError: null,
    postsProcessed: 0,
    seen,
    startedAtSec,
    redditUser: parsed.redditUser,
    twitterHandle: parsed.twitterHandle,
    timer: 0 as unknown as ReturnType<typeof setInterval>,
  };

  const tickReddit = async (live: AgentEntry, redditUser: string) => {
    const r = await fetchRedditUserSubmitted(redditUser);
    if (!r.ok) throw new Error(`Reddit HTTP ${r.status}`);
    const j = (await r.json()) as { data?: { children?: Array<{ data: Record<string, unknown> }> } };
    const children = j.data?.children ?? [];

    for (const ch of children) {
      const d = ch.data ?? {};
      const idKey = String(d.id ?? '');
      if (!idKey || live.seen.has(idKey)) continue;

      const author = String(d.author ?? '').toLowerCase();
      if (author !== redditUser) continue;

      const createdUtc = Number(d.created_utc ?? 0);
      if (createdUtc > 0 && createdUtc < live.startedAtSec) {
        live.seen.add(idKey);
        continue;
      }

      const title = String(d.title ?? '');
      const selftext = String(d.selftext ?? '');
      const combined = [title, selftext].filter(Boolean).join('\n');
      if (!intelLooksActionable(combined, registryKeys)) {
        live.seen.add(idKey);
        continue;
      }

      const permalink = String(d.permalink ?? '');
      const postUrl = permalink.startsWith('http') ? permalink : `https://www.reddit.com${permalink}`;
      const source = `social-agent:reddit:${redditUser}:${postUrl}`;
      const priorSteps = ['social_agent_poll', 'social_agent_new_post'];

      emit('info', `Social agent — Reddit u/${redditUser}`, { postUrl, idKey });

      const fn = runIntel;
      if (!fn) return;
      const out = await fn(combined, source, [...priorSteps]);
      live.seen.add(idKey);

      if ('error' in out) {
        emit('info', `Social agent skipped (intel): ${out.error}`, { postUrl });
      } else {
        live.postsProcessed += 1;
        emit('info', `Social agent intel complete`, {
          postUrl,
          contractAddress: out.contractAddress,
          score: out.consensus.score,
        });
      }
    }
  };

  const tickTwitter = async (live: AgentEntry, handle: string) => {
    const rows = await apifyUserTweets(handle);
    for (const rec of rows) {
      const idKey = String(rec['id'] ?? rec['tweetId'] ?? '');
      if (!idKey || live.seen.has(idKey)) continue;

      const text = String(rec['text'] ?? rec['fullText'] ?? '');
      const createdAt = String(rec['createdAt'] ?? '');
      const createdSec = createdAt ? Math.floor(Date.parse(createdAt) / 1000) : 0;
      if (createdSec > 0 && createdSec < live.startedAtSec) {
        live.seen.add(idKey);
        continue;
      }

      if (!intelLooksActionable(text, registryKeys)) {
        live.seen.add(idKey);
        continue;
      }

      const postUrl =
        typeof rec['url'] === 'string' && (rec['url'] as string).startsWith('http')
          ? (rec['url'] as string)
          : `https://x.com/${handle}/status/${idKey}`;
      const source = `social-agent:twitter:${handle}:${postUrl}`;
      const priorSteps = ['social_agent_poll', 'social_agent_new_post'];

      emit('info', `Social agent — X @${handle}`, { postUrl, idKey });

      const fn = runIntel;
      if (!fn) return;
      const out = await fn(text, source, [...priorSteps]);
      live.seen.add(idKey);

      if ('error' in out) {
        emit('info', `Social agent skipped (intel): ${out.error}`, { postUrl });
      } else {
        live.postsProcessed += 1;
        emit('info', `Social agent intel complete`, {
          postUrl,
          contractAddress: out.contractAddress,
          score: out.consensus.score,
        });
      }
    }
  };

  const tick = async () => {
    const live = agents.get(id);
    if (!live) return;
    live.lastPollAt = Date.now();
    try {
      if (live.platform === 'reddit' && live.redditUser) {
        await tickReddit(live, live.redditUser);
      } else if (live.platform === 'twitter' && live.twitterHandle) {
        await tickTwitter(live, live.twitterHandle);
      }
      live.lastError = null;
    } catch (e) {
      live.lastError = (e as Error).message ?? String(e);
      emit('info', `Social agent poll error (${live.profileUrl}): ${live.lastError}`);
    }
  };

  row.timer = setInterval(() => void tick(), pollMs);
  agents.set(id, row);
  emit('info', `Social scout agent started`, { id, profileUrl: row.profileUrl, platform: row.platform, pollMs });
  void tick();

  return {
    id: row.id,
    profileUrl: row.profileUrl,
    platform: row.platform,
    pollMs: row.pollMs,
    lastPollAt: row.lastPollAt,
    lastError: row.lastError,
    postsProcessed: row.postsProcessed,
  };
}
