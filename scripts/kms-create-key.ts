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

// NOTE: the Orbitport SDK 0.2.1 omits Tags from the wire payload unless
// explicitly provided, but the API requires it (even empty). We bypass the
// SDK's createKey helper and call the JSON-RPC endpoint directly so we
// control the full payload.  Auth (OAuth2 client-credentials) still goes
// through the SDK's auth service.
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

console.log('[kms-create-key] alias       ', alias);
console.log('[kms-create-key] creating key…');

// Step 1 — obtain OAuth2 bearer token
const tokenRes = await fetch('https://auth.spacecomputer.io/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    audience: 'https://op.spacecomputer.io/api',
    grant_type: 'client_credentials',
  }),
});
const tokenBody = await tokenRes.json() as { access_token?: string; error?: string };
if (!tokenBody.access_token) {
  throw new Error(`Auth failed: ${JSON.stringify(tokenBody)}`);
}
const token = tokenBody.access_token;

// Step 2 — create the ETHEREUM-scheme secp256k1 key
const rpcRes = await fetch('https://op.spacecomputer.io/api/v1/rpc', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'kms.CreateKey',
    params: {
      Alias: alias,
      KeySpec: 'ECC_SECG_P256K1',
      KeyUsage: 'SIGN_VERIFY',
      Scheme: 'ETHEREUM',
      Description: 'Argus guardian signing key (secp256k1, Ethereum)',
      Tags: [],
    },
  }),
});
if (!rpcRes.ok) {
  throw new Error(`KMS API error ${rpcRes.status}: ${await rpcRes.text()}`);
}
const rpcBody = await rpcRes.json() as {
  result?: { KeyMetadata: { KeyId: string; Address?: string } };
  error?: unknown;
};
if (rpcBody.error || !rpcBody.result) {
  throw new Error(`KMS RPC error: ${JSON.stringify(rpcBody)}`);
}
const key = { data: rpcBody.result };

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
