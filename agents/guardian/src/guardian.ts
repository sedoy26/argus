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
import type { ProtectedWallet, Score, Signer } from './types.ts';

export interface GuardianConfig {
  /** Address whose risk score we monitor. Approvals to this address
   *  are revoked on threshold breach. */
  spender: Address;
  /** ERC-20 tokens to revoke. We currently revoke each protected
   *  wallet's approval to `spender` on every token in this list. */
  tokens: Address[];
  /** Wallets whose approvals we guard. Each must be controllable by
   *  the configured signer (i.e. `signer.address` matches the wallet
   *  address) — for the demo we hold their private keys directly. */
  protected: ProtectedWallet[];
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
   *  guarded token. Skips wallets that don't match the signer's
   *  address — the demo ships a single signer, but the design allows
   *  pluggable per-wallet signers later. */
  async revokeAll(score: Score): Promise<ActionLog[]> {
    const out: ActionLog[] = [];
    for (const wallet of this.config.protected) {
      if (wallet.address.toLowerCase() !== this.signer.address.toLowerCase()) {
        console.warn(
          `[guardian] skipping ${wallet.label} (${wallet.address}); signer controls ${this.signer.address}`,
        );
        continue;
      }
      for (const token of this.config.tokens) {
        try {
          const { hash } = await revokeApproval({
            client: this.client,
            signer: this.signer,
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
