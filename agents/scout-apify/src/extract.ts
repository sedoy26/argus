// Mine raw post text for (contract address, threat-keyword) pairs.
//
// Two extraction modes:
//
//  1. Address extraction (0x... + keyword) — the original mode.
//     Returns Extraction[] with a resolved EVM address.
//
//  2. Project mention extraction (@handle or $TOKEN + keyword).
//     Returns ProjectMention[] — the caller must resolve the handle
//     to a contract address via the project registry (resolver.ts).
//
// Heuristics, not parsing — lean toward false negatives over false
// positives; the signal-api / applet weighs us anyway.

export type ThreatType = 'SWAT-001' | 'SWAT-002' | 'SWAT-005';

export interface Extraction {
  address: string;
  threatType: ThreatType;
  /** ±120-char window around the address+keyword that triggered. */
  context: string;
  /** Keyword that fired. */
  keyword: string;
  /** Heuristic confidence 0..100 — how strongly we'd vouch for it. */
  reputation: number;
}

/** A threat associated with a @handle or $TOKEN rather than a raw address. */
export interface ProjectMention {
  /** Lower-cased handle without the @ or $ sigil, e.g. "fakeswapnet" */
  handle: string;
  /** Original token as it appeared in the tweet, e.g. "@FakeSwapNet" */
  raw: string;
  threatType: ThreatType;
  context: string;
  keyword: string;
  reputation: number;
}

const ADDR_RE = /(0x[0-9a-fA-F]{40})\b/g;
// Matches @Handle or $TOKEN (2-30 chars, alphanumeric + underscore)
const MENTION_RE = /[@$]([A-Za-z][A-Za-z0-9_]{1,29})\b/g;

interface KeywordRule {
  threat: ThreatType;
  keywords: string[];
  /** Base reputation for this rule before context adjustments. */
  reputation: number;
}

const RULES: KeywordRule[] = [
  {
    threat: 'SWAT-001',
    keywords: [
      'arbitrary call',
      'arbitrary external call',
      'unguarded call',
      'approval drain',
      'approval abuse',
      'transferFrom',
      'execute(',
      'drained',
      'drain attack',
    ],
    reputation: 70,
  },
  {
    threat: 'SWAT-002',
    keywords: [
      'admin compromise',
      'ownership transferred',
      'admin key drained',
      'private key leaked',
      'admin compromised',
    ],
    reputation: 70,
  },
  {
    threat: 'SWAT-005',
    keywords: ['rug pull', 'rugpull', 'liquidity removed', 'exit scam'],
    reputation: 60,
  },
];

/** Generic "this is a real exploit" signal that bumps reputation. */
const URGENCY_BONUS = ['exploit', 'vulnerability', 'attacker', 'hack', 'cve'];

/** Extract (address, threat) pairs from post text. */
export function extract(text: string): Extraction[] {
  const out: Extraction[] = [];
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  for (const m of text.matchAll(ADDR_RE)) {
    const addr = m[1]!.toLowerCase();
    const idx = m.index!;
    const ctx = excerpt(text, idx, m[0].length);
    const ctxLower = ctx.toLowerCase();
    for (const rule of RULES) {
      const kw = rule.keywords.find((k) => ctxLower.includes(k.toLowerCase()));
      if (!kw) continue;
      const dedup = `${addr}:${rule.threat}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      let rep = rule.reputation;
      if (URGENCY_BONUS.some((w) => lower.includes(w))) rep += 10;
      if (rep > 95) rep = 95;
      out.push({ address: addr, threatType: rule.threat, keyword: kw, context: ctx, reputation: rep });
    }
  }
  return out;
}

/**
 * Extract project mentions (@Handle or $TOKEN) paired with threat keywords.
 * Used when a post references a protocol by name/handle instead of 0x address.
 * The caller resolves the handle to a contract address via the project registry.
 */
export function extractMentions(text: string): ProjectMention[] {
  const out: ProjectMention[] = [];
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const raw = m[0]!;       // e.g. "@FakeSwapNet"
    const handle = m[1]!.toLowerCase(); // e.g. "fakeswapnet"
    const idx = m.index!;
    const ctx = excerpt(text, idx, raw.length);
    const ctxLower = ctx.toLowerCase();
    for (const rule of RULES) {
      const kw = rule.keywords.find((k) => ctxLower.includes(k.toLowerCase()));
      if (!kw) continue;
      const dedup = `${handle}:${rule.threat}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      let rep = rule.reputation - 10; // mentions are less certain than explicit addresses
      if (URGENCY_BONUS.some((w) => lower.includes(w))) rep += 10;
      if (rep > 85) rep = 85;
      out.push({ handle, raw, threatType: rule.threat, keyword: kw, context: ctx, reputation: rep });
    }
  }
  return out;
}

function excerpt(text: string, idx: number, len: number, radius = 120): string {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + len + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}
