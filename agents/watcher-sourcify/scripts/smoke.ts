// Watcher smoke — exercises the full path without touching Sourcify.
//
// We hand the watcher a FixedSourcify fixture loaded with the actual
// FakeSwapNet source from contracts/. The detector finds the
// arbitrary-call pattern, the watcher submits a CONFIRMED signal to
// signal-api, and we verify the applet's risk score reflects it.
//
// Prereqs: signal-api on :8787 + applet on :4000.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FixedSourcify } from '../src/sourcify.ts';
import { Watcher } from '../src/watcher.ts';
import { detectAll } from '../src/detector.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKESWAPNET_SRC = readFileSync(
  join(HERE, '../../../contracts/src/FakeSwapNet.sol'),
  'utf8',
);
const MOCK_USDC_SRC = readFileSync(
  join(HERE, '../../../contracts/src/MockUSDC.sol'),
  'utf8',
);

const SIGNAL_API = Bun.env.ARGUS_API ?? 'http://127.0.0.1:8787';
const TARGET_ADDR = '0xc0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';
const CLEAN_ADDR = '0xc1eanc1eanc1eanc1eanc1eanc1eanc1eanc1ea0';

async function main() {
  console.log('1. detector unit check (offline)');
  const report = detectAll([{ name: 'FakeSwapNet.sol', content: FAKESWAPNET_SRC }]);
  console.log(`   detections=${report.detections.length}`);
  for (const d of report.detections) {
    console.log(
      `     ${d.threatType} ${d.file} ${d.signature} (${d.callKind}, accessControlled=${d.accessControlled})`,
    );
  }
  if (report.detections.length === 0) {
    throw new Error('detector failed to find SWAT-001 in FakeSwapNet');
  }

  console.log('\n2. detector negative check on MockUSDC (must be clean)');
  const cleanReport = detectAll([
    { name: 'MockUSDC.sol', content: MOCK_USDC_SRC },
  ]);
  console.log(`   detections=${cleanReport.detections.length}`);
  if (cleanReport.detections.length !== 0) {
    throw new Error(`unexpected detections in MockUSDC: ${JSON.stringify(cleanReport.detections)}`);
  }

  console.log('\n3. wire watcher → fixed sourcify → signal-api');
  const sourcify = new FixedSourcify({
    [`31337:${TARGET_ADDR}`]: {
      status: 'partial',
      files: [{ name: 'FakeSwapNet.sol', content: FAKESWAPNET_SRC }],
      source_url: 'fixture://fakeswapnet.sol',
    },
    [`31337:${CLEAN_ADDR}`]: {
      status: 'partial',
      files: [{ name: 'MockUSDC.sol', content: MOCK_USDC_SRC }],
      source_url: 'fixture://mockusdc.sol',
    },
  });
  const w = new Watcher(
    {
      targets: [
        { chainId: 31337, address: TARGET_ADDR, label: 'fake-swap' },
        { chainId: 31337, address: CLEAN_ADDR, label: 'mock-usdc' },
      ],
      signalApi: SIGNAL_API,
      submitter: 'watcher-sourcify.argus.eth',
      reputation: 90,
      pollMs: 0,
    },
    sourcify,
  );
  const subs = await w.runOnce();
  console.log(`   submitted=${subs.length}`);
  for (const s of subs) {
    if (!s.ok) throw new Error(`submission failed: ${s.error ?? s.status}`);
    console.log(
      `     ${s.target.address} ${s.detection.threatType} → ${s.consensus?.score}`,
    );
  }
  if (subs.length !== 1) throw new Error(`expected 1 submission, got ${subs.length}`);
  if (subs[0]!.target.address !== TARGET_ADDR) {
    throw new Error('submission targeted wrong contract');
  }

  console.log('\n4. dedup — second sweep submits nothing');
  const second = await w.runOnce();
  if (second.length !== 0) {
    throw new Error(`expected 0 dedup'd submissions, got ${second.length}`);
  }
  console.log('   dedup ok');

  console.log('\n5. /risk/:addr reflects watcher submission');
  const risk = (await (await fetch(`${SIGNAL_API}/risk/${TARGET_ADDR}`)).json()) as {
    score: string;
    confirmed: number;
    summary: string;
    attestation: string;
  };
  console.log(`   score=${risk.score} confirmed=${risk.confirmed}`);
  if (risk.score === 'NONE') throw new Error('signal not registered');
  if (!risk.summary.includes('SWAT-001')) {
    throw new Error('SWAT-001 missing from summary');
  }

  console.log('\nOK');
}

await main();
