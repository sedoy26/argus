// Guardian main loop.
//
// Watches one contract address (the "spender" — typically a DeFi
// router or marketplace). Polls signal-api every N seconds for its
// risk score; when the score crosses the configured threshold, the
// guardian iterates over its protected wallets and revokes their
// approvals to the spender on each guarded token.

import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from 'viem';

import { fetchRisk, scoreLevel, signalApiBase } from './risk.ts';
import { revokeApproval } from './protect.ts';
import { notifyGuardianRevoke } from './telemetry.ts';
import type { ProtectedWallet, Score, Signer } from './types.ts';

export interface GuardianConfig {
  /** Address whose risk score we monitor. Approvals to this address
   *  are revoked on threshold breach. */
  spender: Address;
  /** ERC-20 tokens to revoke. We currently revoke each protected
   *  wallet's approval to `spender` on every token in this list. */
  tokens: Address[];
  /** Wallets whose approvals we guard. */
  protected: ProtectedWallet[];
  /** Per-wallet signer overrides. If a wallet address is present here
   *  its signer is used instead of the default signer. This lets the
   *  demo show multiple wallets protected by individual keys while the
   *  primary KMS signer covers the guardian's own address. */
  signerMap?: Map<string, Signer>;
  /** Score level at which the guardian acts. Default: CRITICAL. */
  threshold: Score;
  /** Poll cadence in milliseconds. Default: 5000. */
  pollMs: number;
  /** Public RPC endpoint (Anvil, Sepolia, etc.). */
  rpcUrl: string;
}

export interface ActionLog {
  ts: number;
  wallet: Address;
  token: Address;
  spender: Address;
  txHash: string;
  score: Score;
}

export class Guardian {
  private readonly client: PublicClient;
  private lastScore: Score = 'NONE';
  private actionLog: ActionLog[] = [];
  private running = false;

  constructor(
    public readonly config: GuardianConfig,
    private readonly signer: Signer,
  ) {
    this.client = createPublicClient({ transport: http(config.rpcUrl) });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  /** Latest action log entries; useful for the dashboard / smoke test. */
  history(): ActionLog[] {
    return [...this.actionLog];
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (e) {
        console.error('[guardian] tick failed:', (e as Error).message);
      }
      await Bun.sleep(this.config.pollMs);
    }
  }

  private async tick(): Promise<void> {
    const env = await fetchRisk(this.config.spender);
    const score = env.score;
    const wasBelow = scoreLevel(this.lastScore) < scoreLevel(this.config.threshold);
    const nowAtOrAbove =
      scoreLevel(score) >= scoreLevel(this.config.threshold);

    if (wasBelow && nowAtOrAbove) {
      console.log(
        `[guardian] threshold crossed: ${this.lastScore} → ${score}; revoking approvals`,
      );
      await this.revokeAll(score);
    } else if (this.lastScore !== score) {
      console.log(`[guardian] score ${this.lastScore} → ${score}`);
    }
    this.lastScore = score;
  }

  /** Revoke each protected-wallet's approval to spender across every
   *  guarded token. Uses the per-wallet signer from `signerMap` if
   *  present, otherwise falls back to the default (KMS) signer. */
  async revokeAll(score: Score): Promise<ActionLog[]> {
    const out: ActionLog[] = [];
    for (const wallet of this.config.protected) {
      const walletSigner =
        this.config.signerMap?.get(wallet.address.toLowerCase()) ??
        this.signer;

      if (walletSigner.address.toLowerCase() !== wallet.address.toLowerCase()) {
        console.warn(
          `[guardian] skipping ${wallet.label} (${wallet.address}); no matching signer`,
        );
        continue;
      }
      for (const token of this.config.tokens) {
        try {
          const { hash } = await revokeApproval({
            client: this.client,
            signer: walletSigner,
            token,
            spender: this.config.spender,
          });
          const entry: ActionLog = {
            ts: Date.now(),
            wallet: wallet.address,
            token,
            spender: this.config.spender,
            txHash: hash,
            score,
          };
          this.actionLog.push(entry);
          out.push(entry);
          console.log(
            `[guardian] revoke ${wallet.label} → ${token} on ${this.config.spender} tx=${hash}`,
          );
          void notifyGuardianRevoke({
            wallet: wallet.address,
            token,
            spender: this.config.spender,
            txHash: hash,
            signingMode: walletSigner.signingBackend,
            score,
          });
        } catch (e) {
          console.error(
            `[guardian] revoke FAILED ${wallet.label} ${token}:`,
            (e as Error).message,
          );
        }
      }
    }
    return out;
  }
}

export const summary = {
  signalApi: signalApiBase,
};
