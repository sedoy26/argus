// Mine raw post text for (contract address, threat-keyword) pairs.
//
// Heuristics, not parsing — keep this layer narrow on purpose so a
// noisy feed doesn't silently flip a contract to CRITICAL on a stray
// keyword. The signal-api / applet weighs us against other watchers
// anyway, so we lean toward false negatives over false positives.

export type ThreatType = 'SWAT-001' | 'SWAT-002' | 'SWAT-005';

export interface Extraction {
  address: string;
  threatType: ThreatType;
  /** ±100-char window around the address+keyword that triggered. */
  context: string;
  /** Keyword that fired. */
  keyword: string;
  /** Heuristic confidence 0..100 — how strongly we'd vouch for it. */
  reputation: number;
}

const ADDR_RE = /(0x[0-9a-fA-F]{40})\b/g;

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
      out.push({
        address: addr,
        threatType: rule.threat,
        keyword: kw,
        context: ctx,
        reputation: rep,
      });
    }
  }
  return out;
}

function excerpt(text: string, idx: number, len: number, radius = 120): string {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + len + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}
