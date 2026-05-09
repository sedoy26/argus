// Verify all Argus ENS intelligence text records are reachable on Sepolia.
//
// Reads every text record from the ENS agent profiles and SWAT rules
// and prints a formatted summary, with ✓ / ✗ per record.
//
// Usage:
//   SEPOLIA_RPC_URL=... bun run scripts/ens-verify-intelligence.ts

import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

const RPC_URL = process.env.SEPOLIA_RPC_URL ?? process.env.RPC_URL;
if (!RPC_URL) throw new Error('set SEPOLIA_RPC_URL');

const ENS_ROOT = process.env.ARGUS_ENS_NAME ?? 'argus-security.eth';

const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

async function resolveText(name: string, key: string): Promise<string | null> {
  try {
    return await client.getEnsText({ name, key });
  } catch {
    return null;
  }
}

async function printSection(sectionTitle: string, entries: { name: string; keys: string[] }[]) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(sectionTitle);
  console.log('='.repeat(60));
  for (const { name, keys } of entries) {
    console.log(`\n${name}`);
    const results = await Promise.all(keys.map((k) => resolveText(name, k).then((v) => ({ k, v }))));
    for (const { k, v } of results) {
      const mark = v ? '✓' : '✗';
      const display = v ? v.slice(0, 70) + (v.length > 70 ? '…' : '') : '(not set)';
      console.log(`  ${mark} ${k.padEnd(22)} ${display}`);
    }
  }
}

await printSection('Agent Profiles', [
  {
    name: `guardian.agents.${ENS_ROOT}`,
    keys: ['description', 'trust_tier', 'specialty', 'threshold', 'protected_wallets', 'kms_key_id', 'signal_api', 'actions'],
  },
  {
    name: `watcher-sourcify.agents.${ENS_ROOT}`,
    keys: ['description', 'specialty', 'swat_modules', 'reputation', 'signal_api', 'submitter', 'detection_depth'],
  },
  {
    name: `scout-apify.agents.${ENS_ROOT}`,
    keys: ['description', 'specialty', 'feeds', 'x402_enabled', 'signal_api', 'submitter', 'reputation'],
  },
]);

await printSection('SWAT Detection Rules', [
  {
    name: `swat-001.rules.${ENS_ROOT}`,
    keys: ['name', 'threat_type', 'severity', 'description', 'pattern', 'detection_method', 'example_function', 'references'],
  },
  {
    name: `swat-002.rules.${ENS_ROOT}`,
    keys: ['name', 'threat_type', 'severity', 'description', 'pattern', 'detection_method', 'trigger_event', 'references'],
  },
  {
    name: `swat-003.rules.${ENS_ROOT}`,
    keys: ['name', 'threat_type', 'severity', 'description', 'pattern', 'detection_method', 'trigger_event', 'references'],
  },
]);

console.log('\n');
