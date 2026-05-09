// Sourcify source fetcher — strategy interface + a real and mock impl.
//
// The Argus demo can target either:
//   - real verified contracts on a public chain (use SourcifyHttp)
//   - local Anvil deploys whose source we already have on disk (use
//     LocalFixtures or pass files inline via FixedSourcify)
//
// The watcher only needs a `fetchSources(chainId, address)` call; the
// pattern detector doesn't care where the bytes came from.

export interface SolFile {
  /** Logical filename, e.g. "FakeSwapNet.sol". */
  name: string;
  /** UTF-8 source text. */
  content: string;
  /** Optional original path inside the Sourcify repo; not used by the
   *  detector but echoed in evidence. */
  path?: string;
}

export interface SourcifyResult {
  /** "full" or "partial" per Sourcify's match levels. */
  status: 'full' | 'partial' | 'unknown';
  files: SolFile[];
  /** Original Sourcify URL that produced these files (for evidence). */
  source_url?: string;
}

export interface SourcifyClient {
  fetchSources(chainId: number, address: string): Promise<SourcifyResult | null>;
}

// ---------------------------------------------------------------------------
// HTTP client against sourcify.dev (or a self-hosted mirror)
// ---------------------------------------------------------------------------

export interface SourcifyHttpOptions {
  /** Base URL — e.g. https://sourcify.dev/server (default). */
  baseUrl?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

export class SourcifyHttp implements SourcifyClient {
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(opts: SourcifyHttpOptions = {}) {
    this.base = (opts.baseUrl ?? 'https://sourcify.dev/server').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async fetchSources(
    chainId: number,
    address: string,
  ): Promise<SourcifyResult | null> {
    const url = `${this.base}/files/any/${chainId}/${address}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { signal: ac.signal });
    } catch (e) {
      throw new Error(`sourcify: ${(e as Error).message}`);
    } finally {
      clearTimeout(t);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`sourcify: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      status?: string;
      files?: { name: string; content: string; path?: string }[];
    };
    return {
      status:
        body.status === 'full' || body.status === 'partial'
          ? body.status
          : 'unknown',
      files: (body.files ?? []).filter((f) => f.name.endsWith('.sol')),
      source_url: url,
    };
  }
}

// ---------------------------------------------------------------------------
// Fixed mock — for tests and local Anvil flows
// ---------------------------------------------------------------------------

export class FixedSourcify implements SourcifyClient {
  constructor(private readonly fixtures: Record<string, SourcifyResult>) {}

  async fetchSources(
    chainId: number,
    address: string,
  ): Promise<SourcifyResult | null> {
    const key = `${chainId}:${address.toLowerCase()}`;
    return this.fixtures[key] ?? null;
  }
}
