// Watcher main loop.
//
// For each monitored target (chainId + address) we:
//   1. Fetch verified source from Sourcify (or the configured client).
//   2. If Sourcify has no match, optionally load a local .sol fallback
//      (same bytecode as deployed demo — used when the live address
//      is not yet published to sourcify.dev).
//   3. Run the SWAT detector against every .sol file.
//   4. POST one CONFIRMED signal per (target, threat_type) detection
//      to signal-api. We dedupe submissions in-process so polling
//      doesn't spam the API.

import { readFileSync } from 'node:fs';

import type { Detection, DetectorReport } from './detector.ts';
import { detectAll } from './detector.ts';
import type { SourcifyClient, SourcifyResult } from './sourcify.ts';

/** When Sourcify returns no files, load this path for the given chain+address. */
export interface LocalSourceFallback {
  chainId: number;
  address: string;
  filePath: string;
  /** Logical .sol name for detector output (default: basename of filePath). */
  solName?: string;
}

export interface WatchTarget {
  chainId: number;
  address: string;
  /** Optional friendly name for logs. */
  label?: string;
}

export interface WatcherConfig {
  targets: WatchTarget[];
  signalApi: string;
  /** Submitter identity (text record on the signal). */
  submitter: string;
  /** Reputation 0..100 sent with every signal. */
  reputation: number;
  /** Polling cadence in milliseconds. Set to 0 to run once. */
  pollMs: number;
  /** Optional per-address local .sol when Sourcify has no entry. */
  localFallbacks?: LocalSourceFallback[];
}

export interface SubmissionResult {
  target: WatchTarget;
  detection: Detection;
  ok: boolean;
  status?: number;
  consensus?: { score: string };
  error?: string;
}

export class Watcher {
  private readonly seen = new Set<string>();
  private running = false;

  constructor(
    public readonly config: WatcherConfig,
    private readonly sourcify: SourcifyClient,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  /** Single sweep across every target. Returns the submissions made
   *  (deduped). Useful for smoke tests. */
  async runOnce(): Promise<SubmissionResult[]> {
    const out: SubmissionResult[] = [];
    for (const target of this.config.targets) {
      const result = await this.scan(target);
      out.push(...result);
    }
    return out;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (e) {
        console.error('[watcher] sweep failed:', (e as Error).message);
      }
      if (this.config.pollMs <= 0) break;
      await Bun.sleep(this.config.pollMs);
    }
  }

  private async scan(target: WatchTarget): Promise<SubmissionResult[]> {
    const tag = target.label ?? target.address;
    let sources: SourcifyResult | null;
    try {
      sources = await this.sourcify.fetchSources(target.chainId, target.address);
    } catch (e) {
      console.error(
        `[watcher] sourcify fetch failed for ${tag}: ${(e as Error).message}`,
      );
      return [];
    }
    if (!sources || sources.files.length === 0) {
      const fb = this.tryLocalFallback(target);
      if (fb) {
        console.log(
          `[watcher] ${tag}: no Sourcify files — using local fallback (${fb.source_url})`,
        );
        sources = fb;
      } else {
        console.log(
          `[watcher] ${tag}: no verified sources on Sourcify (and no local fallback) — skip`,
        );
        return [];
      }
    }

    const report: DetectorReport = detectAll(sources.files);
    if (report.detections.length === 0) {
      console.log(`[watcher] ${tag}: clean (${report.scannedFiles.length} files)`);
      return [];
    }

    const submissions: SubmissionResult[] = [];
    for (const d of report.detections) {
      const seenKey = `${target.chainId}:${target.address.toLowerCase()}:${d.threatType}`;
      if (this.seen.has(seenKey)) {
        console.log(`[watcher] ${tag}: dedupe skip (${d.threatType} already submitted this session)`);
        continue;
      }
      this.seen.add(seenKey);
      const sub = await this.submit(target, sources, d);
      submissions.push(sub);
      if (!sub.ok) {
        this.seen.delete(seenKey);
        console.error(
          `[watcher] ${tag}: signal submit FAILED (${d.threatType}): ${sub.error ?? `HTTP ${sub.status}`}`,
        );
      }
    }
    return submissions;
  }

  private async submit(
    target: WatchTarget,
    sources: SourcifyResult,
    d: Detection,
  ): Promise<SubmissionResult> {
    const sourcifyVerificationUrl = `https://sourcify.dev/server/v2/contract/${target.chainId}/${target.address.toLowerCase()}`;
    const evidence = {
      source: sources.source_url?.startsWith('file://') ? 'sourcify+local' : 'sourcify',
      sourcify_status: sources.status,
      sourcify_url: sources.source_url,
      sourcify_verification_url: sourcifyVerificationUrl,
      compiler_metadata:
        'Sourcify full_match / partial_match includes creation bytecode metadata + ABI — not text grep alone.',
      file: d.file,
      function: d.function,
      signature: d.signature,
      callKind: d.callKind,
      bodySnippet: d.bodySnippet,
      accessControlled: d.accessControlled,
      scannedFiles: sources.files.map((f) => f.name),
    };
    const body = {
      contractAddress: target.address,
      chainId: target.chainId,
      threatType: d.threatType,
      verdict: 'CONFIRMED',
      evidence,
      submitter: this.config.submitter,
      // Lower the reputation when the function looks access-controlled
      // — we can't fully reason about modifiers, so cap our confidence.
      reputation: d.accessControlled
        ? Math.max(20, Math.floor(this.config.reputation * 0.4))
        : this.config.reputation,
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
        target,
        detection: d,
        ok: false,
        error: `signal-api unreachable: ${(e as Error).message}`,
      };
    }
    const text = await res.text();
    if (!res.ok) {
      return { target, detection: d, ok: false, status: res.status, error: text };
    }
    let consensus: { score: string } | undefined;
    try {
      const parsed = JSON.parse(text) as { consensus?: { score: string } };
      consensus = parsed.consensus;
    } catch {
      /* leave undefined */
    }
    const tag = target.label ?? target.address;
    console.log(
      `[watcher] submitted ${d.threatType} on ${tag} → ${
        consensus?.score ?? '?'
      } (function=${d.function}, callKind=${d.callKind})`,
    );
    return { target, detection: d, ok: true, status: res.status, consensus };
  }

  private tryLocalFallback(target: WatchTarget): SourcifyResult | null {
    const list = this.config.localFallbacks;
    if (!list?.length) return null;
    const addr = target.address.toLowerCase();
    for (const fb of list) {
      if (fb.chainId !== target.chainId) continue;
      if (fb.address.toLowerCase() !== addr) continue;
      try {
        const content = readFileSync(fb.filePath, 'utf8');
        const name =
          fb.solName ??
          fb.filePath.split(/[/\\]/).pop() ??
          'Contract.sol';
        return {
          status: 'partial',
          files: [{ name, content, path: fb.filePath }],
          source_url: `file://${fb.filePath}`,
        };
      } catch (e) {
        console.error(
          `[watcher] local fallback read failed (${fb.filePath}): ${(e as Error).message}`,
        );
        return null;
      }
    }
    return null;
  }
}
