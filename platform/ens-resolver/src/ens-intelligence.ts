// ENS-backed intelligence layer for Argus.
//
// Agents and the platform read their configuration — detection rules,
// agent profiles, signal-api endpoints — from ENS text records rather
// than env vars or hard-coded constants.  This makes the whole network
// self-describing and discoverable: any agent can resolve another agent's
// capabilities by looking up its ENS name.
//
// ENS namespaces used (under the ARGUS_ENS_ROOT, default argus-security.eth):
//
//   agents.<root>
//     guardian.agents.<root>          — KMS-backed guardian profile
//     watcher-sourcify.agents.<root>  — Sourcify watcher profile
//     scout-apify.agents.<root>       — Apify X402 scout profile
//
//   rules.<root>
//     swat-001.rules.<root>           — Approval-abuse rule
//     swat-002.rules.<root>           — Admin-key compromise rule
//     swat-003.rules.<root>           — Proxy-upgrade exploit rule
//
// All reads are cached in-process for CACHE_TTL_MS to avoid hammering the
// RPC on every poll loop.  Pass `forceRefresh: true` to bypass the cache.
//
// Usage:
//   import { fetchAgentProfile, fetchSwatRule, fetchAllSwatRules } from './ens-intelligence.ts';
//   const profile = await fetchAgentProfile('guardian');
//   const rule = await fetchSwatRule('SWAT-001');

import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ENS_ROOT = process.env.ARGUS_ENS_ROOT ?? 'argus-security.eth';
const RPC_URL = process.env.SEPOLIA_RPC_URL ?? process.env.RPC_URL;

const client = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL ?? ''),
});

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Keys stored under guardian.agents.<root> */
export interface AgentProfile {
  /** ENS name this profile was loaded from. */
  name: string;
  description: string;
  trust_tier: string;
  specialty: string;
  swat_modules: string[];     // e.g. ['SWAT-001', 'SWAT-002']
  reputation: number;         // 0-100
  signal_api: string;
  submitter: string;
  threshold: string;          // guardian only: 'CRITICAL' | 'RED' | etc.
  actions: string;
  /** All raw text records, including keys not modelled above. */
  raw: Record<string, string>;
}

/** Keys stored under swat-XXX.rules.<root> */
export interface SwatRule {
  /** e.g. 'SWAT-001' */
  id: string;
  name: string;
  threat_type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  pattern: string;
  detection_method: string;
  references: string;
  /** All raw text records. */
  raw: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Known text-record keys per namespace
// ---------------------------------------------------------------------------

const AGENT_KEYS = [
  'description', 'trust_tier', 'specialty', 'swat_modules', 'reputation',
  'signal_api', 'submitter', 'threshold', 'protected_wallets', 'kms_key_id',
  'kms_key_address', 'actions', 'feeds', 'x402_enabled', 'detection_depth',
];

const RULE_KEYS = [
  'name', 'threat_type', 'severity', 'description', 'pattern',
  'detection_method', 'example_function', 'victim_action', 'attacker_action',
  'trigger_event', 'risk_indicator', 'references',
];

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<Record<string, string>>>();

async function resolveTextRecords(
  ensName: string,
  keys: string[],
  forceRefresh = false,
): Promise<Record<string, string>> {
  const cacheKey = ensName;
  if (!forceRefresh) {
    const entry = cache.get(cacheKey);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
  }

  const records: Record<string, string> = {};
  const settled = await Promise.allSettled(
    keys.map((key) =>
      client.getEnsText({ name: ensName, key }).then((val) => ({ key, val })),
    ),
  );
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value.val) {
      records[r.value.key] = r.value.val;
    }
  }

  cache.set(cacheKey, { value: records, expiresAt: Date.now() + CACHE_TTL_MS });
  return records;
}

// ---------------------------------------------------------------------------
// Agent profiles
// ---------------------------------------------------------------------------

/**
 * Resolve a named agent's profile from ENS.
 *
 * `agentLabel` is the first label of the agent subname, e.g.:
 *   'guardian'           → guardian.agents.<root>
 *   'watcher-sourcify'   → watcher-sourcify.agents.<root>
 *   'scout-apify'        → scout-apify.agents.<root>
 */
export async function fetchAgentProfile(
  agentLabel: string,
  opts?: { forceRefresh?: boolean },
): Promise<AgentProfile> {
  const ensName = `${agentLabel}.agents.${ENS_ROOT}`;
  const raw = await resolveTextRecords(ensName, AGENT_KEYS, opts?.forceRefresh);

  return {
    name: ensName,
    description: raw.description ?? '',
    trust_tier: raw.trust_tier ?? 'unknown',
    specialty: raw.specialty ?? '',
    swat_modules: raw.swat_modules ? raw.swat_modules.split(',').map((s) => s.trim()) : [],
    reputation: raw.reputation ? Number(raw.reputation) : 80,
    signal_api: raw.signal_api ?? '',
    submitter: raw.submitter ?? ensName,
    threshold: raw.threshold ?? 'CRITICAL',
    actions: raw.actions ?? '',
    raw,
  };
}

// ---------------------------------------------------------------------------
// SWAT rules
// ---------------------------------------------------------------------------

/**
 * Resolve a SWAT detection rule from ENS.
 *
 * `swatId` is case-insensitive, e.g. 'SWAT-001' or 'swat-001'.
 *
 * Returns the rule parameters that watchers use to configure detection.
 */
export async function fetchSwatRule(
  swatId: string,
  opts?: { forceRefresh?: boolean },
): Promise<SwatRule> {
  const label = swatId.toLowerCase();
  const ensName = `${label}.rules.${ENS_ROOT}`;
  const raw = await resolveTextRecords(ensName, RULE_KEYS, opts?.forceRefresh);

  return {
    id: swatId.toUpperCase(),
    name: raw.name ?? swatId,
    threat_type: raw.threat_type ?? swatId.toUpperCase(),
    severity: (raw.severity as SwatRule['severity']) ?? 'HIGH',
    description: raw.description ?? '',
    pattern: raw.pattern ?? '',
    detection_method: raw.detection_method ?? '',
    references: raw.references ?? '',
    raw,
  };
}

/**
 * Resolve all SWAT rules defined in ENS.
 * Returns a map keyed by rule ID (e.g. 'SWAT-001').
 */
export async function fetchAllSwatRules(
  opts?: { forceRefresh?: boolean },
): Promise<Map<string, SwatRule>> {
  const ids = ['SWAT-001', 'SWAT-002', 'SWAT-003'];
  const rules = await Promise.all(ids.map((id) => fetchSwatRule(id, opts)));
  return new Map(rules.map((r) => [r.id, r]));
}

// ---------------------------------------------------------------------------
// Convenience: print all intelligence to stdout (for debugging)
// ---------------------------------------------------------------------------

export async function printIntelligence(): Promise<void> {
  console.log(`\n[ens-intel] ENS root: ${ENS_ROOT}\n`);

  console.log('=== Agent Profiles ===');
  for (const label of ['guardian', 'watcher-sourcify', 'scout-apify']) {
    try {
      const p = await fetchAgentProfile(label);
      console.log(`\n${p.name}`);
      console.log(`  trust_tier:   ${p.trust_tier}`);
      console.log(`  specialty:    ${p.specialty}`);
      console.log(`  swat_modules: ${p.swat_modules.join(', ') || '(none)'}`);
      console.log(`  reputation:   ${p.reputation}`);
      console.log(`  signal_api:   ${p.signal_api}`);
      if (p.threshold) console.log(`  threshold:    ${p.threshold}`);
    } catch (e) {
      console.log(`  ERROR: ${(e as Error).message}`);
    }
  }

  console.log('\n=== SWAT Detection Rules ===');
  for (const id of ['SWAT-001', 'SWAT-002', 'SWAT-003']) {
    try {
      const r = await fetchSwatRule(id);
      console.log(`\n${id}: ${r.name}`);
      console.log(`  severity:    ${r.severity}`);
      console.log(`  pattern:     ${r.pattern}`);
      console.log(`  detection:   ${r.detection_method}`);
      console.log(`  description: ${r.description}`);
    } catch (e) {
      console.log(`  ERROR: ${(e as Error).message}`);
    }
  }
}
