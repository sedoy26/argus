// Step 3 of the Sepolia wiring: verify CCIP-Read resolution.
//
// Calls ENS resolution for `<ARGUS_TEST_ADDR>.<ARGUS_ENS_NAME>` and
// asks for a few text records — the gateway behind ArgusRiskResolver
// answers them. We hit Sepolia's public RPC and use viem's built-in
// CCIP-Read client (it follows OffchainLookup automatically).
//
// Env:
//   SEPOLIA_RPC_URL   public Sepolia RPC
//   ARGUS_ENS_NAME    the name with the resolver attached
//   ARGUS_TEST_ADDR   the contract whose risk score we want (0x… 20 bytes)
//
// Usage:
//   SEPOLIA_RPC_URL=...  ARGUS_ENS_NAME=argus-demo.eth \
//     ARGUS_TEST_ADDR=0xdeadbeef... bun run verify

import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

const SEPOLIA_RPC_URL = envOrThrow('SEPOLIA_RPC_URL');
const ARGUS_ENS_NAME = envOrThrow('ARGUS_ENS_NAME');
const ARGUS_TEST_ADDR = envOrThrow('ARGUS_TEST_ADDR');

const wildcard = `${ARGUS_TEST_ADDR}.${ARGUS_ENS_NAME}`;

const client = createPublicClient({
  chain: sepolia,
  transport: http(SEPOLIA_RPC_URL),
  // CCIP-Read is on by default in viem (pass `false` to disable).
});

console.log('[verify] resolving', wildcard);
console.log('[verify] via       ', SEPOLIA_RPC_URL);

const keys = ['score', 'confidence', 'summary', 'attestation', 'updated'] as const;
console.log('\ntext records:');
for (const key of keys) {
  try {
    const v = await client.getEnsText({ name: wildcard, key });
    console.log(`  ${key.padEnd(18)} ${v ?? '(empty)'}`);
  } catch (e) {
    console.log(`  ${key.padEnd(18)} ERROR ${(e as Error).message.slice(0, 80)}…`);
  }
}

try {
  const a = await client.getEnsAddress({ name: wildcard });
  console.log(`\naddress              ${a ?? '(empty)'}`);
} catch (e) {
  console.log(`\naddress              ERROR ${(e as Error).message.slice(0, 80)}…`);
}
