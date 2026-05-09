// One-time helper: create an ETHEREUM-scheme KMS key in
// SpaceComputer Orbitport and print the env block the guardian
// needs.
//
// Env in:
//   ORBITPORT_CLIENT_ID
//   ORBITPORT_CLIENT_SECRET
//   ARGUS_KEY_ALIAS    (optional, default "argus-guardian-<timestamp>")
//
// Output: stdout — paste into agents/guardian/.env
//
//   KMS_KEY_ID=...
//   KMS_KEY_ADDRESS=0x...
//
// You then need to fund KMS_KEY_ADDRESS on whichever chain your
// guardian targets — typically Sepolia ~0.05 ETH covers many
// revoke transactions.
//
// This script is idempotent in the sense that re-running it creates
// *another* key. There is no destroy step on purpose — losing access
// to the key id only forfeits future signing, never exposes the
// private material.

import { OrbitportSDK } from '@spacecomputer-io/orbitport-sdk-ts';

const clientId = process.env.ORBITPORT_CLIENT_ID;
const clientSecret = process.env.ORBITPORT_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(
    'set ORBITPORT_CLIENT_ID and ORBITPORT_CLIENT_SECRET (from https://accounts.spacecomputer.io)',
  );
  process.exit(2);
}

const alias =
  process.env.ARGUS_KEY_ALIAS ?? `argus-guardian-${Date.now()}`;

const sdk = new OrbitportSDK({
  config: { clientId, clientSecret },
});

console.log('[kms-create-key] alias       ', alias);
console.log('[kms-create-key] creating key…');
const key = await sdk.kms.createKey({
  alias,
  keySpec: 'ECC_SECG_P256K1',
  keyUsage: 'SIGN_VERIFY',
  scheme: 'ETHEREUM',
});

const keyId = key.data.KeyMetadata.KeyId;
const address = key.data.KeyMetadata.Address;
if (!address) {
  throw new Error(
    'KMS did not return Address; expected ETHEREUM-scheme metadata',
  );
}

console.log();
console.log('[kms-create-key] success');
console.log('[kms-create-key] paste this into agents/guardian/.env:');
console.log();
console.log(`KMS_KEY_ID=${keyId}`);
console.log(`KMS_KEY_ADDRESS=${address}`);
console.log(`# alias: ${alias}`);
console.log();
console.log('[kms-create-key] next: fund', address);
console.log('  Sepolia faucet: https://sepoliafaucet.com  (~0.05 ETH covers a demo)');
console.log('  Anvil:         cast send --value 1ether --rpc-url http://127.0.0.1:8546 --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', address);
