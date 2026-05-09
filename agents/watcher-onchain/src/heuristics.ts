// Suspicion heuristics for new admin / implementation addresses.
//
// We treat an address as suspicious if it's a "fresh" EOA — never
// transacted, no balance, no on-chain identity. The TamaGo watcher
// can be extended later to also check ENS reverse records and
// known-multisig allowlists.

import {
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

export interface AddressProfile {
  address: Address;
  balanceWei: bigint;
  txCount: number;
  isContract: boolean;
}

export interface SuspicionResult {
  suspicious: boolean;
  reason: string;
  /** Reputation we attach to the resulting signal (0..100). Higher is
   *  more confident the address is suspicious. */
  reputation: number;
  profile: AddressProfile;
}

export async function profileAddress(
  client: PublicClient,
  addr: Address,
): Promise<AddressProfile> {
  const [balanceWei, txCount, code] = await Promise.all([
    client.getBalance({ address: addr }),
    client.getTransactionCount({ address: addr }),
    client.getCode({ address: addr }),
  ]);
  return {
    address: addr,
    balanceWei,
    txCount,
    isContract: !!code && code !== '0x',
  };
}

export function evaluateAdmin(profile: AddressProfile): SuspicionResult {
  if (profile.isContract) {
    return {
      suspicious: false,
      reason: 'admin is a contract (likely a multisig / DAO module)',
      reputation: 30,
      profile,
    };
  }
  if (profile.balanceWei === 0n && profile.txCount === 0) {
    return {
      suspicious: true,
      reason: 'fresh EOA — zero balance, zero tx history',
      reputation: 80,
      profile,
    };
  }
  if (profile.txCount < 3) {
    return {
      suspicious: true,
      reason: `low-activity EOA — ${profile.txCount} prior tx(s)`,
      reputation: 60,
      profile,
    };
  }
  return {
    suspicious: false,
    reason: `EOA with ${profile.txCount} prior tx(s)`,
    reputation: 30,
    profile,
  };
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Hex;
