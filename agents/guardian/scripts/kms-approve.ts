// One-time setup: have the KMS address approve FakeSwapNet for max MockUSDC.
// Run once after `bun run kms-create-key` and before the live demo.
//
// Uses the same KmsSigner as the guardian — the private key never leaves KMS.
//
// Env (same as guardian .env):
//   ORBITPORT_CLIENT_ID, ORBITPORT_CLIENT_SECRET, KMS_KEY_ID, KMS_KEY_ADDRESS
//   RPC_URL, GUARDIAN_SPENDER (FakeSwapNet), GUARDIAN_TOKENS (MockUSDC)

import { createPublicClient, encodeFunctionData, http, parseEther } from 'viem';
import { sepolia } from 'viem/chains';
import { signerFromEnv } from '../src/signer.ts';
import { revokeApproval } from '../src/protect.ts';

const RPC_URL = Bun.env.RPC_URL ?? 'http://127.0.0.1:8545';
const SPENDER = Bun.env.GUARDIAN_SPENDER as `0x${string}`;
const TOKEN = (Bun.env.GUARDIAN_TOKENS ?? '').split(',')[0]?.trim() as `0x${string}`;

if (!SPENDER || !TOKEN) {
  console.error('set GUARDIAN_SPENDER and GUARDIAN_TOKENS in env');
  process.exit(1);
}

console.log('[kms-approve] connecting KMS signer…');
const signer = await signerFromEnv();
console.log('[kms-approve] signer address:', signer.address);

const client = createPublicClient({ transport: http(RPC_URL) });

// Check current allowance
const allowanceData = encodeFunctionData({
  abi: [{ name: 'allowance', type: 'function', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] }],
  functionName: 'allowance',
  args: [signer.address, SPENDER],
});
const currentAllowance = await client.call({ to: TOKEN, data: allowanceData });
console.log('[kms-approve] current allowance:', currentAllowance.data);

// Build approve(SPENDER, max) transaction
const approveData = encodeFunctionData({
  abi: [{ name: 'approve', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
  functionName: 'approve',
  args: [SPENDER, 2n ** 256n - 1n],
});

const nonce = await client.getTransactionCount({ address: signer.address });
const feeData = await client.estimateFeesPerGas();

const tx = {
  chainId: (await client.getChainId()),
  to: TOKEN,
  data: approveData,
  nonce,
  gas: 60000n,
  maxFeePerGas: feeData.maxFeePerGas ?? parseEther('0.000000002'),
  maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? parseEther('0.000000001'),
  value: 0n,
  type: 'eip1559' as const,
};

console.log('[kms-approve] signing via KMS…');
const signed = await signer.signTransaction(tx);

console.log('[kms-approve] broadcasting…');
const hash = await client.sendRawTransaction({ serializedTransaction: signed });
console.log('[kms-approve] tx hash:', hash);

const receipt = await client.waitForTransactionReceipt({ hash });
console.log('[kms-approve] status:', receipt.status === 'success' ? 'SUCCESS ✓' : 'FAILED ✗');
console.log('[kms-approve] KMS address now has unlimited approval to FakeSwapNet');
