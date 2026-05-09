// Build and broadcast a single revoke transaction.

import {
  type Address,
  type Hex,
  type PublicClient,
  encodeFunctionData,
} from 'viem';

import type { Signer } from './types.ts';

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
];

export interface RevokeResult {
  hash: Hex;
  /** What the signer set the allowance to (always 0n for now). */
  newAllowance: bigint;
}

export interface BuildRevokeArgs {
  client: PublicClient;
  signer: Signer;
  token: Address;
  spender: Address;
  /** Override gas / fees for testing. */
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

/** Construct, sign, and broadcast `approve(spender, 0)` on `token`
 *  from `signer.address`. */
export async function revokeApproval(args: BuildRevokeArgs): Promise<RevokeResult> {
  const { client, signer, token, spender } = args;

  const data = encodeFunctionData({
    abi: ERC20_APPROVE,
    functionName: 'approve',
    args: [spender, 0n],
  });

  const [nonce, chainId, fees] = await Promise.all([
    client.getTransactionCount({ address: signer.address, blockTag: 'pending' }),
    client.getChainId(),
    estimateFees(client, args),
  ]);

  const gas =
    args.gas ??
    (await client.estimateGas({
      account: signer.address,
      to: token,
      data,
    }));

  const tx = {
    type: 'eip1559' as const,
    chainId,
    nonce,
    to: token,
    data,
    value: 0n,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };

  const signed = await signer.signTransaction(tx);
  const hash = await client.sendRawTransaction({ serializedTransaction: signed });
  return { hash, newAllowance: 0n };
}

async function estimateFees(
  client: PublicClient,
  args: BuildRevokeArgs,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  if (args.maxFeePerGas !== undefined && args.maxPriorityFeePerGas !== undefined) {
    return {
      maxFeePerGas: args.maxFeePerGas,
      maxPriorityFeePerGas: args.maxPriorityFeePerGas,
    };
  }
  const fees = await client.estimateFeesPerGas();
  return {
    maxFeePerGas: args.maxFeePerGas ?? fees.maxFeePerGas,
    maxPriorityFeePerGas:
      args.maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas,
  };
}
