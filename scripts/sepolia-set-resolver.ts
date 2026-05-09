// Step 2 of the Sepolia wiring: set the deployed ArgusRiskResolver
// as the resolver for a name you own on Sepolia ENS.
//
// Calls ENS Registry's `setResolver(node, resolver)`. Caller must be
// the owner of `node` on the registry — i.e. the address that owns
// the ENS name.
//
// Env:
//   PRIVATE_KEY       0x… deployer key (must own the ENS name)
//   SEPOLIA_RPC_URL   RPC endpoint (Alchemy/Infura/public)
//   ARGUS_ENS_NAME    e.g. argus-demo.eth — the wildcard root
//   ARGUS_RESOLVER    deployed ArgusRiskResolver address (from forge script)
//
// Usage:
//   cd scripts
//   bun install
//   PRIVATE_KEY=0x... SEPOLIA_RPC_URL=... \
//     ARGUS_ENS_NAME=argus-demo.eth \
//     ARGUS_RESOLVER=0xABC... \
//     bun run set-resolver

import {
  type Hex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  namehash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

// Sepolia ENS Registry (same address as mainnet).
const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e' as const;

const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'setResolver',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'resolver', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'resolver',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
] as const;

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

const PRIVATE_KEY = envOrThrow('PRIVATE_KEY') as Hex;
const SEPOLIA_RPC_URL = envOrThrow('SEPOLIA_RPC_URL');
const ARGUS_ENS_NAME = envOrThrow('ARGUS_ENS_NAME');
const ARGUS_RESOLVER = envOrThrow('ARGUS_RESOLVER') as Hex;

const account = privateKeyToAccount(PRIVATE_KEY);
const transport = http(SEPOLIA_RPC_URL);
const publicClient = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ account, chain: sepolia, transport });

const node = namehash(ARGUS_ENS_NAME);

console.log('[wiring] account     ', account.address);
console.log('[wiring] ENS name    ', ARGUS_ENS_NAME);
console.log('[wiring] node        ', node);
console.log('[wiring] resolver    ', ARGUS_RESOLVER);

console.log('\n1. check ENS name ownership');
const owner = (await publicClient.readContract({
  address: ENS_REGISTRY,
  abi: REGISTRY_ABI,
  functionName: 'owner',
  args: [node],
})) as Hex;
console.log('   owner is', owner);
if (owner.toLowerCase() === '0x0000000000000000000000000000000000000000') {
  throw new Error(
    `${ARGUS_ENS_NAME} is unowned on Sepolia ENS — register it at https://sepolia.app.ens.domains first`,
  );
}
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error(
    `${ARGUS_ENS_NAME} is owned by ${owner} but signing key controls ${account.address}`,
  );
}

console.log('\n2. read current resolver');
const before = (await publicClient.readContract({
  address: ENS_REGISTRY,
  abi: REGISTRY_ABI,
  functionName: 'resolver',
  args: [node],
})) as Hex;
console.log('   before:', before);

if (before.toLowerCase() === ARGUS_RESOLVER.toLowerCase()) {
  console.log('   already set — nothing to do');
  process.exit(0);
}

console.log('\n3. setResolver tx');
const data = encodeFunctionData({
  abi: REGISTRY_ABI,
  functionName: 'setResolver',
  args: [node, ARGUS_RESOLVER],
});
const txHash = await wallet.sendTransaction({
  to: ENS_REGISTRY,
  data,
});
console.log('   tx', txHash);
console.log('   waiting for receipt...');
const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash });
console.log('   block', rcpt.blockNumber, 'status', rcpt.status);

console.log('\n4. read back');
const after = (await publicClient.readContract({
  address: ENS_REGISTRY,
  abi: REGISTRY_ABI,
  functionName: 'resolver',
  args: [node],
})) as Hex;
console.log('   after:', after);
if (after.toLowerCase() !== ARGUS_RESOLVER.toLowerCase()) {
  throw new Error(`resolver mismatch — expected ${ARGUS_RESOLVER}, got ${after}`);
}
console.log('\nOK');
