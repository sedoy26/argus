// Project registry resolver — maps Twitter/X handles and protocol names
// to on-chain contract addresses.
//
// Sources (checked in order, first non-null wins):
//
//  1. LOCAL_REGISTRY  — hardcoded map; instant, no network; covers demo
//                       contracts and well-known protocols.
//
//  2. ENS text records — <handle>.projects.argus-security.eth
//                        text key "address" → contract address
//                        text key "chain"   → chainId (default: 11155111 Sepolia)
//                        Registered via scripts/ens-register-intelligence.ts.
//
// Returns null if the handle is unknown (signal is skipped, not errored).
// Results are cached for 5 minutes so repeated mentions in a batch don't
// spam ENS.

import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e' as const;
const PUBLIC_RESOLVER = '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD' as const;
const BASE_NAME = 'argus-security.eth';
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';

export interface ResolvedProject {
  address: string;   // 0x + 40 hex, lower-case
  chainId: number;
  name: string;      // human-readable project name
}

// ---------------------------------------------------------------------------
// Local registry — instant lookup, demo-grade
// ---------------------------------------------------------------------------
//
// Key: lower-case handle (without @ or $) or any alias for the project.
// Multiple keys can point to the same entry.

const LOCAL_REGISTRY: Record<string, ResolvedProject> = {
  // ── Demo contracts (Sepolia) ─────────────────────────────────────────────
  fakeswapnet: {
    address: '0x3b38fe80891ec608829e941ef965e1c96d3460d6',
    chainId: 11155111,
    name: 'FakeSwapNet',
  },
  fakeswap: {
    address: '0x3b38fe80891ec608829e941ef965e1c96d3460d6',
    chainId: 11155111,
    name: 'FakeSwapNet',
  },
  fsn: {
    address: '0x3b38fe80891ec608829e941ef965e1c96d3460d6',
    chainId: 11155111,
    name: 'FakeSwapNet',
  },

  // ── Real protocols (Ethereum mainnet) ────────────────────────────────────
  uniswap:  { address: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', chainId: 1, name: 'Uniswap' },
  aave:     { address: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', chainId: 1, name: 'Aave' },
  compound: { address: '0xc00e94cb662c3520282e6f5717214004a7f26888', chainId: 1, name: 'Compound' },
};

// ---------------------------------------------------------------------------
// ENS lookup helpers
// ---------------------------------------------------------------------------

function namehash(name: string): `0x${string}` {
  let node = new Uint8Array(32);
  if (!name) return ('0x' + Buffer.from(node).toString('hex')) as `0x${string}`;
  const labels = name.split('.').reverse();
  for (const label of labels) {
    const labelHash = new Uint8Array(
      Array.from(
        Buffer.from(
          require('crypto').createHash('sha256').update(label).digest(),
        ),
      ),
    );
    const combined = new Uint8Array(64);
    combined.set(node, 0);
    combined.set(labelHash, 32);
    node = new Uint8Array(
      Array.from(
        Buffer.from(
          require('crypto').createHash('sha256').update(combined).digest(),
        ),
      ),
    );
  }
  return ('0x' + Buffer.from(node).toString('hex')) as `0x${string}`;
}

// ---------------------------------------------------------------------------
// Cache + main resolver
// ---------------------------------------------------------------------------

const cache = new Map<string, { value: ResolvedProject | null; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve a handle (without @ or $) to a project entry.
 * Returns null if unknown.
 */
export async function resolveProject(raw: string): Promise<ResolvedProject | null> {
  const handle = raw.toLowerCase().replace(/^[@$]/, '');

  // 1. Cache
  const cached = cache.get(handle);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  // 2. Local registry
  const local = LOCAL_REGISTRY[handle];
  if (local) {
    cache.set(handle, { value: local, expiresAt: Date.now() + CACHE_TTL_MS });
    return local;
  }

  // 3. ENS text records: <handle>.projects.argus-security.eth
  let ensResult: ResolvedProject | null = null;
  try {
    const ensName = `${handle}.projects.${BASE_NAME}`;
    const node = namehash(ensName);

    const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });

    // getText('address') on the public resolver
    const address = await client.readContract({
      address: PUBLIC_RESOLVER,
      abi: [{ name: 'text', type: 'function', stateMutability: 'view',
              inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }],
              outputs: [{ name: '', type: 'string' }] }],
      functionName: 'text',
      args: [node, 'address'],
    }) as string;

    if (address && address.startsWith('0x') && address.length === 42) {
      const chainText = await client.readContract({
        address: PUBLIC_RESOLVER,
        abi: [{ name: 'text', type: 'function', stateMutability: 'view',
                inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }],
                outputs: [{ name: '', type: 'string' }] }],
        functionName: 'text',
        args: [node, 'chain'],
      }) as string;

      const nameText = await client.readContract({
        address: PUBLIC_RESOLVER,
        abi: [{ name: 'text', type: 'function', stateMutability: 'view',
                inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }],
                outputs: [{ name: '', type: 'string' }] }],
        functionName: 'text',
        args: [node, 'name'],
      }) as string;

      ensResult = {
        address: address.toLowerCase(),
        chainId: chainText ? Number(chainText) : 11155111,
        name: nameText || handle,
      };
      console.log(`[resolver] ENS hit: ${ensName} → ${address}`);
    }
  } catch {
    // ENS lookup failed — network issue or name not registered; not fatal
  }

  cache.set(handle, { value: ensResult, expiresAt: Date.now() + CACHE_TTL_MS });
  return ensResult;
}
