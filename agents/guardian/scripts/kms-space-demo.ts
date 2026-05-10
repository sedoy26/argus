#!/usr/bin/env bun
/**
 * SpaceComputer KMS cross-track demo line for judges:
 *   kms.CreateKey (unless KMS_KEY_ID already set) → build revoke approve(0) tx
 *   → kms.sign(DIGEST) via Orbitport → optional broadcast → POST /telemetry
 *   so the Argus dashboard shows **Signed via Space KMS ✓**.
 *
 * Env (required):
 *   ORBITPORT_CLIENT_ID, ORBITPORT_CLIENT_SECRET
 *
 * Env (optional):
 *   KMS_KEY_ID, KMS_KEY_ADDRESS — skip CreateKey when both intent is reuse
 *   RPC_URL — default: Sepolia public HTTP
 *   GUARDIAN_SPENDER — default: Sepolia FakeSwapNet demo
 *   GUARDIAN_TOKENS — default: first token = Sepolia MockUSDC demo
 *   ARGUS_API, ARGUS_TELEMETRY_SECRET — same as guardian; required for feed ingest
 *
 *   KMS_DEMO_BROADCAST=1 — after sign, sendRawTransaction (needs Sepolia ETH on KMS address)
 */

import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseGwei,
  type Address,
  type Hex,
} from 'viem';
import { KmsSigner } from '../src/signer.ts';
import { notifyArgusTelemetry } from '../src/telemetry.ts';

const DEFAULT_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const DEFAULT_SPENDER = '0x3B38fE80891Ec608829E941EF965e1c96d3460D6' as Address;
const DEFAULT_TOKEN = '0x1be5B14d985c1A33DF0433197150227C4fd07e30' as Address;

const ERC20_APPROVE = [
  {
    type: 'function' as const,
    name: 'approve',
    stateMutability: 'nonpayable' as const,
    inputs: [
      { name: 'spender', type: 'address' as const },
      { name: 'amount', type: 'uint256' as const },
    ],
    outputs: [{ type: 'bool' as const }],
  },
] as const;

async function orbitportBearer(): Promise<string> {
  const clientId = Bun.env.ORBITPORT_CLIENT_ID;
  const clientSecret = Bun.env.ORBITPORT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('ORBITPORT_CLIENT_ID and ORBITPORT_CLIENT_SECRET are required');
  }
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
  const tokenBody = (await tokenRes.json()) as { access_token?: string };
  if (!tokenBody.access_token) {
    throw new Error(`OAuth failed: ${JSON.stringify(tokenBody)}`);
  }
  return tokenBody.access_token;
}

async function createEthereumKmsKey(): Promise<{ keyId: string; address: Address }> {
  const alias = Bun.env.ARGUS_KEY_ALIAS ?? `argus-kms-demo-${Date.now()}`;
  const token = await orbitportBearer();
  const rpcRes = await fetch('https://op.spacecomputer.io/api/v1/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'kms.CreateKey',
      params: {
        Alias: alias,
        KeySpec: 'ECC_SECG_P256K1',
        KeyUsage: 'SIGN_VERIFY',
        Scheme: 'ETHEREUM',
        Description: 'Argus guardian KMS demo (secp256k1)',
        Tags: [],
      },
    }),
  });
  if (!rpcRes.ok) {
    throw new Error(`kms.CreateKey HTTP ${rpcRes.status}: ${await rpcRes.text()}`);
  }
  const rpcBody = (await rpcRes.json()) as {
    result?: { KeyMetadata: { KeyId: string; Address?: string } };
    error?: unknown;
  };
  if (rpcBody.error || !rpcBody.result?.KeyMetadata?.KeyId) {
    throw new Error(`kms.CreateKey RPC error: ${JSON.stringify(rpcBody)}`);
  }
  const km = rpcBody.result.KeyMetadata;
  const addr = km.Address;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error('KMS CreateKey did not return an Ethereum Address');
  }
  return { keyId: km.KeyId, address: addr.toLowerCase() as Address };
}

async function main(): Promise<void> {
  const rpcUrl = Bun.env.RPC_URL ?? DEFAULT_RPC;
  const spender = (Bun.env.GUARDIAN_SPENDER ?? DEFAULT_SPENDER).toLowerCase() as Address;
  const tokenRaw = (Bun.env.GUARDIAN_TOKENS ?? DEFAULT_TOKEN).split(',')[0]?.trim();
  const token = (tokenRaw ?? DEFAULT_TOKEN).toLowerCase() as Address;

  let keyId = Bun.env.KMS_KEY_ID?.trim() ?? '';
  let keyAddress = (Bun.env.KMS_KEY_ADDRESS?.trim() ?? '') as Address | '';

  if (!keyId) {
    console.log('[kms-demo] creating new ETHEREUM-scheme KMS key (kms.CreateKey)…');
    const created = await createEthereumKmsKey();
    keyId = created.keyId;
    keyAddress = created.address;
    console.log('[kms-demo] createKey ✓', keyId, keyAddress);
    await notifyArgusTelemetry(
      `Space KMS: createKey ✓ — Argus guardian demo key ${keyAddress.slice(0, 10)}…${keyAddress.slice(-6)}`,
      {
        kind: 'space_kms_demo',
        phase: 'createKey',
        space_kms_signed: true,
        signed_via: 'space_kms',
        kms_key_id: keyId,
        kms_address: keyAddress,
        spender,
        token,
      },
    );
  } else {
    console.log('[kms-demo] reusing KMS_KEY_ID from env');
  }

  const signer = await KmsSigner.connect({
    clientId: Bun.env.ORBITPORT_CLIENT_ID!,
    clientSecret: Bun.env.ORBITPORT_CLIENT_SECRET!,
    keyId,
    address: keyAddress ? (keyAddress as Address) : undefined,
    authDomain: Bun.env.ORBITPORT_AUTH_DOMAIN,
    apiUrl: Bun.env.ORBITPORT_API_URL,
  });

  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  const data = encodeFunctionData({
    abi: ERC20_APPROVE,
    functionName: 'approve',
    args: [spender, 0n],
  });

  const nonce = await client.getTransactionCount({ address: signer.address, blockTag: 'pending' });
  const fees = await client.estimateFeesPerGas().catch(() => ({
    maxFeePerGas: parseGwei('50'),
    maxPriorityFeePerGas: parseGwei('2'),
  }));

  const tx = {
    type: 'eip1559' as const,
    chainId,
    nonce,
    to: token,
    data,
    value: 0n,
    gas: 80_000n,
    maxFeePerGas: fees.maxFeePerGas ?? parseGwei('50'),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? parseGwei('2'),
  };

  console.log('[kms-demo] signing revoke-shaped EIP-1559 tx via kms.sign(DIGEST)…');
  const signed = (await signer.signTransaction(tx)) as Hex;
  console.log('[kms-demo] signed raw tx bytes:', signed.slice(0, 42), '…');

  await notifyArgusTelemetry(
    'Space KMS: kms.sign(DIGEST) on revoke calldata ✓ — signed by Space KMS',
    {
      kind: 'space_kms_demo',
      phase: 'signRevokeDigest',
      space_kms_signed: true,
      signed_via: 'space_kms',
      kms_key_id: keyId,
      wallet: signer.address,
      token,
      spender,
      chain_id: chainId,
      signed_tx_prefix: signed.slice(0, 24),
    },
  );

  if (Bun.env.KMS_DEMO_BROADCAST === '1' || Bun.env.KMS_DEMO_BROADCAST === 'true') {
    console.log('[kms-demo] broadcasting (KMS_DEMO_BROADCAST=1)…');
    const hash = await client.sendRawTransaction({ serializedTransaction: signed });
    console.log('[kms-demo] tx hash:', hash);
    await notifyArgusTelemetry(`Guardian revoke signed via Space KMS ✓ — ${hash.slice(0, 12)}…`, {
      kind: 'guardian_revoke',
      space_kms_signed: true,
      signed_via: 'space_kms',
      txHash: hash,
      wallet: signer.address,
      token,
      spender,
      score: 'KMS_DEMO',
    });
  } else {
    console.log('[kms-demo] skip broadcast (set KMS_DEMO_BROADCAST=1 to submit on-chain)');
  }

  console.log('[kms-demo] done. If telemetry did not appear, set ARGUS_TELEMETRY_SECRET to match signal-api.');
}

await main();
