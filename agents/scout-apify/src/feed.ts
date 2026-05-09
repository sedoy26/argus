// Pluggable feed strategy for the scout.
//
// In production we hit Apify Actors via an X402-paid request (USDC on Base).
// For smoke tests we hand the scout a fixed set of "tweets" so it can run
// hermetically.
//
// Each feed item is the raw text we'll mine for addresses + vuln
// keywords, plus the metadata we ship as evidence.

export interface FeedItem {
  /** Stable identifier — author + post-id is fine. We dedupe on this. */
  id: string;
  /** Source name (e.g. "twitter:peckshield") for display + evidence. */
  source: string;
  /** Author handle / display name. */
  author?: string;
  /** Permalink to the original post. */
  url?: string;
  /** Timestamp (unix seconds) — used for the signal's wire `ts`. */
  ts?: number;
  /** Raw text we're going to mine. */
  text: string;
}

export interface FeedClient {
  fetchLatest(): Promise<FeedItem[]>;
}

// ---------------------------------------------------------------------------
// MockFeed — for smoke tests and the local demo
// ---------------------------------------------------------------------------

export class MockFeed implements FeedClient {
  constructor(private readonly items: FeedItem[]) {}

  async fetchLatest(): Promise<FeedItem[]> {
    return [...this.items];
  }
}

// ---------------------------------------------------------------------------
// ApifyFeed — production path against Apify Actor results
// ---------------------------------------------------------------------------

export interface ApifyFeedOptions {
  /** Apify Actor identifier, e.g. "apify/twitter-scraper". */
  actorId: string;
  /** Body POSTed to the run-sync-get-dataset endpoint. */
  runInput: Record<string, unknown>;
  /** Standard Apify bearer token. Use this OR x402PrivateKey. */
  apifyToken?: string;
  /**
   * X402 payment path: hex private key of a wallet funded with USDC on
   * Base mainnet (0x833589… contract). The feed will do the full
   * 402 → sign → retry handshake automatically.
   * Docs: https://docs.apify.com/platform/integrations/x402
   */
  x402PrivateKey?: `0x${string}`;
  /** Field on the dataset record holding the post text. */
  textField?: string;
  /** Field on the dataset record holding the post id. */
  idField?: string;
  /** Field on the dataset record holding the post author. */
  authorField?: string;
  /** Field on the dataset record holding the post timestamp (unix s). */
  timestampField?: string;
  /** Apify base URL. Override only for staging/self-hosted. */
  baseUrl?: string;
}

export class ApifyFeed implements FeedClient {
  private readonly base: string;
  constructor(private readonly opts: ApifyFeedOptions) {
    if (!opts.apifyToken && !opts.x402PrivateKey) {
      throw new Error('ApifyFeed: provide apifyToken or x402PrivateKey');
    }
    this.base = opts.baseUrl ?? 'https://api.apify.com/v2';
  }

  async fetchLatest(): Promise<FeedItem[]> {
    // Apify actor ID format: "owner/name" → URL uses "owner~name"
    const actorSlug = this.opts.actorId.replace('/', '~');
    const url = `${this.base}/acts/${actorSlug}/run-sync-get-dataset-items?clean=1`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.opts.apifyToken) {
      headers['authorization'] = `Bearer ${this.opts.apifyToken}`;
    }

    let r: Response;
    if (this.opts.x402PrivateKey) {
      // Full X402 handshake: 402 → sign → retry with PAYMENT-SIGNATURE
      const { fetchWithX402 } = await import('./x402.ts');
      r = await fetchWithX402(url, { method: 'POST', headers, body: JSON.stringify(this.opts.runInput) }, this.opts.x402PrivateKey);
    } else {
      r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(this.opts.runInput) });
    }

    if (!r.ok) {
      throw new Error(`Apify ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const rows = (await r.json()) as Record<string, unknown>[];
    const textField = this.opts.textField ?? 'text';
    const idField = this.opts.idField ?? 'id';
    const authorField = this.opts.authorField ?? 'author';
    const tsField = this.opts.timestampField ?? 'createdAt';

    return rows
      .map((row) => {
        const text = row[textField];
        if (typeof text !== 'string') return null;
        const id = String(row[idField] ?? cryptoRandomId());
        const author = typeof row[authorField] === 'string' ? (row[authorField] as string) : undefined;
        const tsRaw = row[tsField];
        let ts: number | undefined;
        if (typeof tsRaw === 'number') ts = tsRaw;
        else if (typeof tsRaw === 'string') {
          const n = Date.parse(tsRaw);
          if (!Number.isNaN(n)) ts = Math.floor(n / 1000);
        }
        const item: FeedItem = {
          id,
          source: `apify:${this.opts.actorId}`,
          text,
        };
        if (author) item.author = author;
        if (ts) item.ts = ts;
        return item;
      })
      .filter((x): x is FeedItem => x !== null);
  }
}

function cryptoRandomId(): string {
  return 'fid-' + Math.random().toString(36).slice(2, 12);
}
