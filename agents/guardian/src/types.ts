// Shared types for the guardian.

import type { Address, Hex, TransactionSerializable } from 'viem';

/** Risk score levels emitted by the Argus consensus engine. */
export type Score = 'NONE' | 'YELLOW' | 'ORANGE' | 'RED' | 'CRITICAL';

export interface ConsensusEnvelope {
  score: Score;
  confidence: number;
  count: number;
  confirmed: number;
  addr: string;
  summary: string;
  last_signal_ts: number;
  applet_ts_ns: number;
  code_hash: string;
  boot_commitment: string;
  attestation: string;
}

/** A wallet whose approvals we are guarding. */
export interface ProtectedWallet {
  /** Friendly label for logs. */
  label: string;
  /** Address whose approvals we revoke. The signer must control this. */
  address: Address;
  /** Nonce manager identity — usually the same as `address`. */
}

/** A single protective action queued by the guardian. */
export interface RevokeAction {
  wallet: ProtectedWallet;
  token: Address;
  spender: Address;
  /** Reason — recorded in logs and the action ledger. */
  reason: string;
}

/** Signer abstraction. The guardian doesn't care whether the key
 *  lives in a KMS or a local file; it asks the signer to sign a
 *  pre-built transaction and gets back the broadcastable raw hex. */
export interface Signer {
  /** Address that this signer represents on-chain. */
  readonly address: Address;
  /** `kms` when signing via SpaceComputer Orbitport; `local` for dev keys. */
  readonly signingBackend: 'kms' | 'local';
  /** Sign an unsigned EIP-1559 / legacy transaction and return the
   *  serialized signed bytes ready for `eth_sendRawTransaction`. */
  signTransaction(tx: TransactionSerializable): Promise<Hex>;
}
