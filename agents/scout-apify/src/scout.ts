// Scout main loop. Polls a FeedClient, mines each item for
// vulnerability mentions, posts UNCONFIRMED-by-default signals to
// signal-api.
//
// We default to UNCONFIRMED because off-chain text is hearsay until
// another witness (sourcify, on-chain) confirms it. The applet's
// scoring rule reflects this: SWAT verdicts compose; one UNCONFIRMED
// alone doesn't escalate past YELLOW. Bump to CONFIRMED via env if you
// trust the source explicitly.

import { createHash } from 'node:crypto';

import type { FeedClient, FeedItem } from './feed.ts';
import { extract, type Extraction } from './extract.ts';

export interface ScoutConfig {
  feed: FeedClient;
  signalApi: string;
  submitter: string;
  /** Bound on the per-extraction reputation (0..100). */
  maxReputation: number;
  /** Default `chainId` to attach to signals — extracted addresses
   *  don't carry a chain. The apify scout submits one tag set per
   *  configured chain to make sense in a multi-chain demo, but for
   *  v1 we bind to a single chain. */
  chainId: number;
  /** Verdict the scout submits. Default UNCONFIRMED. */
  verdict: 'UNCONFIRMED' | 'CONFIRMED';
  /** Polling cadence ms; 0 means run-once. */
  pollMs: number;
}

export interface SubmissionResult {
  ok: boolean;
  status?: number;
  error?: string;
  consensus?: { score: string };
  body: unknown;
}

export class Scout {
  private readonly seen = new Set<string>();
  private running = false;

  constructor(private readonly config: ScoutConfig) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  /** One sweep: fetch latest items, mine each, submit unique signals. */
  async runOnce(): Promise<SubmissionResult[]> {
    const items = await this.config.feed.fetchLatest();
    const out: SubmissionResult[] = [];
    for (const item of items) {
      out.push(...(await this.processItem(item)));
    }
    return out;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (e) {
        console.error('[scout] sweep failed:', (e as Error).message);
      }
      if (this.config.pollMs <= 0) break;
      await Bun.sleep(this.config.pollMs);
    }
  }

  private async processItem(item: FeedItem): Promise<SubmissionResult[]> {
    const extractions = extract(item.text);
    if (extractions.length === 0) return [];
    const out: SubmissionResult[] = [];
    for (const e of extractions) {
      const seenKey = `${item.id}:${e.address}:${e.threatType}`;
      if (this.seen.has(seenKey)) continue;
      this.seen.add(seenKey);
      out.push(await this.submit(item, e));
    }
    return out;
  }

  private async submit(
    item: FeedItem,
    e: Extraction,
  ): Promise<SubmissionResult> {
    const evidence = {
      source: 'apify',
      feed: item.source,
      itemId: item.id,
      author: item.author,
      url: item.url,
      keyword: e.keyword,
      excerpt: e.context,
      // Hash the raw text so re-fetches produce the same evidence_hash.
      textSha256: '0x' + createHash('sha256').update(item.text).digest('hex'),
    };
    const reputation = Math.min(e.reputation, this.config.maxReputation);
    const body = {
      contractAddress: e.address,
      chainId: this.config.chainId,
      threatType: e.threatType,
      verdict: this.config.verdict,
      evidence,
      submitter: this.config.submitter,
      reputation,
      timestamp: item.ts,
    };
    let res: Response;
    try {
      res = await fetch(`${this.config.signalApi}/signals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return {
        ok: false,
        error: `signal-api unreachable: ${(err as Error).message}`,
        body,
      };
    }
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: text, body };
    }
    let consensus: { score: string } | undefined;
    try {
      consensus = (JSON.parse(text) as { consensus?: { score: string } }).consensus;
    } catch {
      /* ignore */
    }
    console.log(
      `[scout] ${e.threatType} @ ${e.address.slice(0, 10)}…  via "${e.keyword}" → ${consensus?.score ?? '?'}`,
    );
    return { ok: true, status: res.status, consensus, body };
  }
}
