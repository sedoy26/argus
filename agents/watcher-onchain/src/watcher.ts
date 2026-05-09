// On-chain watcher main loop.
//
// For each monitored target we poll viem for OwnershipTransferred and
// Upgraded logs since the last block we processed. New events go
// through `evaluateAdmin` (heuristics.ts); the watcher emits a
// signal-api submission per qualifying event.
//
// Polling rather than subscriptions keeps the agent transport-
// agnostic — works against any HTTP RPC, no WS dependency.

import {
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  parseAbiItem,
} from 'viem';

import { evaluateAdmin, profileAddress, ZERO_ADDRESS } from './heuristics.ts';

const OWNERSHIP_TRANSFERRED = parseAbiItem(
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
);
const UPGRADED = parseAbiItem('event Upgraded(address indexed implementation)');

export interface WatchTarget {
  chainId: number;
  address: Address;
  /** Friendly label for logs. */
  label?: string;
}

export interface WatcherConfig {
  client: PublicClient;
  targets: WatchTarget[];
  signalApi: string;
  submitter: string;
  /** Cap on per-event reputation. Heuristics may go higher; we clamp. */
  maxReputation: number;
  /** Polling cadence ms. */
  pollMs: number;
  /** Block to start scanning from. Defaults to "latest" (skip
   *  history). */
  fromBlock?: bigint;
}

export interface SubmissionResult {
  ok: boolean;
  status?: number;
  consensus?: { score: string };
  error?: string;
  signalBody: unknown;
}

export class Watcher {
  private cursor = new Map<string, bigint>();
  private running = false;

  constructor(public readonly config: WatcherConfig) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  /** Single sweep: returns the submissions made in this sweep across
   *  every target. Useful for smoke tests. */
  async sweep(): Promise<SubmissionResult[]> {
    const out: SubmissionResult[] = [];
    const head = await this.config.client.getBlockNumber();
    for (const target of this.config.targets) {
      const key = this.targetKey(target);
      const fromBlock =
        this.cursor.get(key) ?? this.config.fromBlock ?? head;
      const fresh = await this.scanTarget(target, fromBlock, head);
      out.push(...fresh);
      this.cursor.set(key, head + 1n);
    }
    return out;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.sweep();
      } catch (e) {
        console.error('[watcher-onchain] sweep failed:', (e as Error).message);
      }
      await Bun.sleep(this.config.pollMs);
    }
  }

  private async scanTarget(
    target: WatchTarget,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<SubmissionResult[]> {
    if (toBlock < fromBlock) return [];
    const tag = target.label ?? target.address;
    const [ownershipLogs, upgradeLogs] = await Promise.all([
      this.config.client.getLogs({
        address: target.address,
        event: OWNERSHIP_TRANSFERRED,
        fromBlock,
        toBlock,
      }),
      this.config.client.getLogs({
        address: target.address,
        event: UPGRADED,
        fromBlock,
        toBlock,
      }),
    ]);

    const submissions: SubmissionResult[] = [];
    for (const log of ownershipLogs) {
      const r = await this.handleOwnershipTransferred(target, log);
      if (r) submissions.push(r);
    }
    for (const log of upgradeLogs) {
      const r = await this.handleUpgraded(target, log);
      if (r) submissions.push(r);
    }
    if (submissions.length === 0 && (ownershipLogs.length || upgradeLogs.length)) {
      console.log(`[watcher-onchain] ${tag}: events seen, all benign`);
    }
    return submissions;
  }

  private async handleOwnershipTransferred(
    target: WatchTarget,
    log: Log<bigint, number, false, typeof OWNERSHIP_TRANSFERRED>,
  ): Promise<SubmissionResult | null> {
    const previousOwner = log.args.previousOwner!;
    const newOwner = log.args.newOwner!;
    if (newOwner === ZERO_ADDRESS) {
      // Renouncing ownership — typically benign or even good.
      return null;
    }
    if (previousOwner === ZERO_ADDRESS) {
      // Constructor-time event; the deploy itself, not a compromise.
      return null;
    }
    const profile = await profileAddress(this.config.client, newOwner);
    const verdict = evaluateAdmin(profile);
    if (!verdict.suspicious) {
      console.log(
        `[watcher-onchain] ${target.label ?? target.address} OwnershipTransferred → ${newOwner} benign (${verdict.reason})`,
      );
      return null;
    }
    return this.submit({
      target,
      threatType: 'SWAT-002',
      verdict: 'CONFIRMED',
      reputation: Math.min(verdict.reputation, this.config.maxReputation),
      evidence: {
        source: 'on-chain',
        event: 'OwnershipTransferred',
        previousOwner,
        newOwner,
        block: log.blockNumber!.toString(),
        txHash: log.transactionHash,
        adminProfile: {
          balanceWei: profile.balanceWei.toString(),
          txCount: profile.txCount,
          isContract: profile.isContract,
        },
        suspicion: verdict.reason,
      },
    });
  }

  private async handleUpgraded(
    target: WatchTarget,
    log: Log<bigint, number, false, typeof UPGRADED>,
  ): Promise<SubmissionResult | null> {
    const impl = log.args.implementation!;
    const profile = await profileAddress(this.config.client, impl);
    // For SWAT-003 a non-contract implementation would never be valid;
    // any verified-EOA implementation is suspicious by construction.
    const suspicious = !profile.isContract;
    if (!suspicious) {
      console.log(
        `[watcher-onchain] ${target.label ?? target.address} Upgraded → ${impl} (contract, deferred verification)`,
      );
      return null;
    }
    return this.submit({
      target,
      threatType: 'SWAT-003',
      verdict: 'CONFIRMED',
      reputation: Math.min(70, this.config.maxReputation),
      evidence: {
        source: 'on-chain',
        event: 'Upgraded',
        implementation: impl,
        block: log.blockNumber!.toString(),
        txHash: log.transactionHash,
        suspicion: 'Upgraded to a non-contract address',
      },
    });
  }

  private async submit(args: {
    target: WatchTarget;
    threatType: 'SWAT-002' | 'SWAT-003';
    verdict: 'CONFIRMED' | 'UNCONFIRMED';
    reputation: number;
    evidence: Record<string, unknown>;
  }): Promise<SubmissionResult> {
    const body = {
      contractAddress: args.target.address,
      chainId: args.target.chainId,
      threatType: args.threatType,
      verdict: args.verdict,
      evidence: args.evidence,
      submitter: this.config.submitter,
      reputation: args.reputation,
    };
    let res: Response;
    try {
      res = await fetch(`${this.config.signalApi}/signals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return {
        ok: false,
        error: `signal-api unreachable: ${(e as Error).message}`,
        signalBody: body,
      };
    }
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: text, signalBody: body };
    }
    let consensus: { score: string } | undefined;
    try {
      consensus = (JSON.parse(text) as { consensus?: { score: string } }).consensus;
    } catch {
      /* ignore */
    }
    const tag = args.target.label ?? args.target.address;
    console.log(
      `[watcher-onchain] submitted ${args.threatType} on ${tag} → ${
        consensus?.score ?? '?'
      }`,
    );
    return { ok: true, status: res.status, consensus, signalBody: body };
  }

  private targetKey(t: WatchTarget): string {
    return `${t.chainId}:${t.address.toLowerCase()}`;
  }
}

export type { Hex, Address };
