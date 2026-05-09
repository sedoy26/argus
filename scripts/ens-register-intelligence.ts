// Register Argus intelligence subnames on argus-security.eth (Sepolia).
//
// Creates three ENS namespaces under the root name:
//
//   agents.argus-security.eth
//     guardian.agents.argus-security.eth          — KMS-backed guardian profile
//     watcher-sourcify.agents.argus-security.eth  — Sourcify watcher profile
//     scout-apify.agents.argus-security.eth        — Apify X402 scout profile
//
//   rules.argus-security.eth
//     swat-001.rules.argus-security.eth            — Approval-abuse rule
//     swat-002.rules.argus-security.eth            — Admin-key compromise rule
//     swat-003.rules.argus-security.eth            — Proxy-upgrade exploit rule
//
//   projects.argus-security.eth                   — Protocol registry
//     fakeswapnet.projects.argus-security.eth     — Demo contract (Sepolia)
//     (extensible: any protocol the community registers)
//
// Each subname is owned by the deployer and points to the Sepolia Public
// Resolver so viem's `getEnsText()` can resolve text records off the shelf.
//
// Env:
//   PRIVATE_KEY        0x… deployer key (owns argus-security.eth)
//   SEPOLIA_RPC_URL    Alchemy / Infura Sepolia URL
//   ARGUS_ENS_NAME     root name (default: argus-security.eth)
//   ARGUS_GATEWAY_URL  public URL of the Railway ENS gateway
//   ARGUS_API_URL      public URL of the signal-api (tunnel or Railway)
//
// Usage:
//   cd /Users/gg/Downloads/heg
//   PRIVATE_KEY=0x... SEPOLIA_RPC_URL=... bun run scripts/ens-register-intelligence.ts

import {
  type Hex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  namehash,
  toBytes,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e' as Hex;
// Sepolia Public Resolver — supports setText / text
const PUBLIC_RESOLVER = '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD' as Hex;

const REGISTRY_ABI = [
  {
    type: 'function', name: 'setSubnodeOwner', stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'label', type: 'bytes32' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function', name: 'setResolver', stateMutability: 'nonpayable',
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'resolver', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function', name: 'owner', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
] as const;

const RESOLVER_ABI = [
  {
    type: 'function', name: 'setText', stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
      { name: 'value', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'text', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }],
    outputs: [{ type: 'string' }],
  },
] as const;

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`set ${name}`);
  return v;
}

const PRIVATE_KEY = env('PRIVATE_KEY') as Hex;
const RPC_URL = env('SEPOLIA_RPC_URL');
const ROOT_NAME = env('ARGUS_ENS_NAME', 'argus-security.eth');
const GATEWAY_URL = env('ARGUS_GATEWAY_URL', 'https://argus-gateway-production.up.railway.app');
const API_URL = env('ARGUS_API_URL', 'https://safari-witness-tomorrow-pressing.trycloudflare.com');

const account = privateKeyToAccount(PRIVATE_KEY);
const transport = http(RPC_URL);
const pub = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ account, chain: sepolia, transport });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function labelHash(label: string): Hex {
  return keccak256(toBytes(label)) as Hex;
}

async function sendAndWait(data: Hex, to: Hex, label: string): Promise<void> {
  const tx = await wallet.sendTransaction({ to, data });
  console.log(`    tx ${tx}`);
  await pub.waitForTransactionReceipt({ hash: tx });
  console.log(`    ${label} ✓`);
}

async function ensureSubname(parentNode: Hex, label: string, owner: Hex): Promise<Hex> {
  const node = namehash(`${label}.${ROOT_NAME}`) as Hex;
  // Check if already owned
  const current = await pub.readContract({
    address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'owner', args: [node],
  });
  if ((current as string).toLowerCase() === owner.toLowerCase()) {
    console.log(`  ${label} — already owned, skipping setSubnodeOwner`);
  } else {
    console.log(`  ${label} — setSubnodeOwner`);
    const data = encodeFunctionData({
      abi: REGISTRY_ABI, functionName: 'setSubnodeOwner',
      args: [parentNode, labelHash(label), owner],
    });
    await sendAndWait(data, ENS_REGISTRY, `setSubnodeOwner(${label})`);
  }
  return node;
}

async function setResolver(node: Hex, label: string): Promise<void> {
  const data = encodeFunctionData({
    abi: REGISTRY_ABI, functionName: 'setResolver',
    args: [node, PUBLIC_RESOLVER],
  });
  await sendAndWait(data, ENS_REGISTRY, `setResolver(${label})`);
}

async function setText(node: Hex, key: string, value: string): Promise<void> {
  const data = encodeFunctionData({
    abi: RESOLVER_ABI, functionName: 'setText',
    args: [node, key, value],
  });
  await sendAndWait(data, PUBLIC_RESOLVER, `setText(${key}=${value.slice(0, 40)})`);
}

async function setTexts(node: Hex, records: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(records)) {
    await setText(node, key, value);
  }
}

// ---------------------------------------------------------------------------
// Intelligence data
// ---------------------------------------------------------------------------

const SWAT_RULES: Record<string, Record<string, string>> = {
  'swat-001': {
    name: 'Approval Abuse',
    threat_type: 'SWAT-001',
    severity: 'HIGH',
    description: 'Arbitrary-call pattern allows approval drain via transferFrom',
    pattern: 'arbitrary-call',
    detection_method: 'sourcify-source-analysis',
    example_function: 'execute(address,bytes)',
    victim_action: 'approve(spender, amount)',
    attacker_action: 'execute(token, abi.encodeCall(transferFrom, (victim, attacker, amount)))',
    references: 'https://www.swcregistry.io/docs/SWC-107',
  },
  'swat-002': {
    name: 'Admin Key Compromise',
    threat_type: 'SWAT-002',
    severity: 'HIGH',
    description: 'Admin key compromised or transferred to unknown EOA',
    pattern: 'OwnershipTransferred-unknown',
    detection_method: 'onchain-event-monitor',
    trigger_event: 'OwnershipTransferred',
    risk_indicator: 'new owner has no ENS name and no on-chain history',
    references: 'https://www.swcregistry.io/docs/SWC-106',
  },
  'swat-003': {
    name: 'Proxy Upgrade Exploit',
    threat_type: 'SWAT-003',
    severity: 'CRITICAL',
    description: 'Proxy upgraded to unverified or malicious implementation',
    pattern: 'Upgraded-unverified',
    detection_method: 'onchain-event-monitor',
    trigger_event: 'Upgraded',
    risk_indicator: 'new implementation not verified on Sourcify',
    references: 'https://eips.ethereum.org/EIPS/eip-1967',
  },
};

// Agent profiles — what each agent publishes to the ENS agent registry
function agentRecords(apiUrl: string, gatewayUrl: string): Record<string, Record<string, string>> {
  return {
    guardian: {
      description: 'Argus guardian — revokes token approvals via KMS when risk threshold is reached',
      trust_tier: 'kms-attested',
      threshold: 'CRITICAL',
      protected_wallets: '5',
      kms_key_id: 'kms:argus-guardian-main',
      signal_api: apiUrl,
      specialty: 'approval-revocation',
      actions: 'revoke_approval',
    },
    'watcher-sourcify': {
      description: 'Argus Sourcify watcher — detects vulnerability patterns in verified source code',
      specialty: 'sourcify-analysis',
      swat_modules: 'SWAT-001,SWAT-002',
      reputation: '90',
      signal_api: apiUrl,
      submitter: `watcher-sourcify.agents.${ROOT_NAME}`,
      detection_depth: 'deep',
    },
    'scout-apify': {
      description: 'Argus Apify scout — monitors security researcher feeds via X402 payments',
      specialty: 'social-intelligence',
      feeds: 'peckshield,certik,slowmist,samczsun',
      x402_enabled: 'true',
      signal_api: apiUrl,
      submitter: `scout-apify.agents.${ROOT_NAME}`,
      reputation: '75',
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n[ens-intel] account      ${account.address}`);
console.log(`[ens-intel] root name    ${ROOT_NAME}`);
console.log(`[ens-intel] gateway url  ${GATEWAY_URL}`);
console.log(`[ens-intel] api url      ${API_URL}`);

const rootNode = namehash(ROOT_NAME) as Hex;

// 1 — agents.argus-security.eth
console.log('\n=== agents namespace ===');
const agentsNode = await ensureSubname(rootNode, 'agents', account.address as Hex);
// Use the full nested namehash for children
const agentsFullNode = namehash(`agents.${ROOT_NAME}`) as Hex;
await setResolver(agentsNode, 'agents');

const profiles = agentRecords(API_URL, GATEWAY_URL);
for (const [label, records] of Object.entries(profiles)) {
  console.log(`\n--- ${label}.agents.${ROOT_NAME} ---`);
  // Create subname under agents node (we need to use agents.argus-security.eth as parent)
  const childNode = namehash(`${label}.agents.${ROOT_NAME}`) as Hex;
  const current = await pub.readContract({
    address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'owner', args: [childNode],
  });
  if ((current as string).toLowerCase() !== account.address.toLowerCase()) {
    const data = encodeFunctionData({
      abi: REGISTRY_ABI, functionName: 'setSubnodeOwner',
      args: [agentsFullNode, labelHash(label), account.address as Hex],
    });
    await sendAndWait(data, ENS_REGISTRY, `setSubnodeOwner(${label}.agents)`);
  } else {
    console.log(`  ${label} — already owned`);
  }
  await setResolver(childNode, `${label}.agents`);
  await setTexts(childNode, records);
}

// 2 — rules.argus-security.eth
console.log('\n=== rules namespace ===');
const rulesNode = await ensureSubname(rootNode, 'rules', account.address as Hex);
const rulesFullNode = namehash(`rules.${ROOT_NAME}`) as Hex;
await setResolver(rulesNode, 'rules');

for (const [label, records] of Object.entries(SWAT_RULES)) {
  console.log(`\n--- ${label}.rules.${ROOT_NAME} ---`);
  const childNode = namehash(`${label}.rules.${ROOT_NAME}`) as Hex;
  const current = await pub.readContract({
    address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'owner', args: [childNode],
  });
  if ((current as string).toLowerCase() !== account.address.toLowerCase()) {
    const data = encodeFunctionData({
      abi: REGISTRY_ABI, functionName: 'setSubnodeOwner',
      args: [rulesFullNode, labelHash(label), account.address as Hex],
    });
    await sendAndWait(data, ENS_REGISTRY, `setSubnodeOwner(${label}.rules)`);
  } else {
    console.log(`  ${label} — already owned`);
  }
  await setResolver(childNode, `${label}.rules`);
  await setTexts(childNode, records);
}

// 3 — projects.argus-security.eth  (protocol → contract address registry)
console.log('\n=== projects namespace ===');
const projectsNode = await ensureSubname(rootNode, 'projects', account.address as Hex);
const projectsFullNode = namehash(`projects.${ROOT_NAME}`) as Hex;
await setResolver(projectsNode, 'projects');

const PROJECTS: Record<string, Record<string, string>> = {
  fakeswapnet: {
    name: 'FakeSwapNet',
    address: '0x3b38fe80891ec608829e941ef965e1c96d3460d6',
    chain: '11155111',
    twitter: 'FakeSwapNet',
    description: 'Demo DeFi swap protocol with arbitrary-call vulnerability (Sepolia testnet)',
    risk: 'CRITICAL',
  },
};

for (const [label, records] of Object.entries(PROJECTS)) {
  console.log(`\n--- ${label}.projects.${ROOT_NAME} ---`);
  const childNode = namehash(`${label}.projects.${ROOT_NAME}`) as Hex;
  const current = await pub.readContract({
    address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'owner', args: [childNode],
  });
  if ((current as string).toLowerCase() !== account.address.toLowerCase()) {
    const data = encodeFunctionData({
      abi: REGISTRY_ABI, functionName: 'setSubnodeOwner',
      args: [projectsFullNode, labelHash(label), account.address as Hex],
    });
    await sendAndWait(data, ENS_REGISTRY, `setSubnodeOwner(${label}.projects)`);
  } else {
    console.log(`  ${label} — already owned`);
  }
  await setResolver(childNode, `${label}.projects`);
  await setTexts(childNode, records);
}

console.log('\n[ens-intel] All intelligence records registered ✓');
console.log('\nVerify with:');
console.log(`  bun run scripts/ens-verify-intelligence.ts`);
