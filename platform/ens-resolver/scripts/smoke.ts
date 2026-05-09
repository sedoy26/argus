// End-to-end smoke for the CCIP-Read gateway.
//
// Simulates the on-chain resolver's OffchainLookup payload entirely in
// JS, posts it to the gateway, and verifies the gateway's reply round-
// trips through ABI-decoding to the value we expect from signal-api.
//
// Assumes:
//   1. QEMU is running (make qemu)
//   2. signal-api is running on :8787
//   3. Gateway is running on :8788  (bun run dev in another shell)

import {
  encodeAbiParameters,
  encodeFunctionData,
  decodeAbiParameters,
  namehash,
  pad,
  type Hex,
} from 'viem';
import { encodeName } from '../src/dns.ts';

const GATEWAY = Bun.env.ARGUS_GATEWAY ?? 'http://127.0.0.1:8788';
const SIGNAL_API = Bun.env.ARGUS_API ?? 'http://127.0.0.1:8787';

const ADDR = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hex;
const FULL_NAME = `${ADDR}.risks.argus.eth`;

function buildLookupData(callData: Hex): Hex {
  // The on-chain resolver passes abi.encode(name, callData) as
  // OffchainLookup.callData.
  const dnsName = encodeName(FULL_NAME.split('.'));
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes' }],
    [dnsName, callData],
  );
}

function buildTextCallData(name: string, key: string): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'text',
        stateMutability: 'view',
        inputs: [
          { name: 'node', type: 'bytes32' },
          { name: 'key', type: 'string' },
        ],
        outputs: [{ type: 'string' }],
      },
    ],
    functionName: 'text',
    args: [namehash(name), key],
  });
}

function buildAddrCallData(name: string): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'addr',
        stateMutability: 'view',
        inputs: [{ name: 'node', type: 'bytes32' }],
        outputs: [{ type: 'address' }],
      },
    ],
    functionName: 'addr',
    args: [namehash(name)],
  });
}

async function lookup(callData: Hex): Promise<Hex> {
  const data = buildLookupData(callData);
  // Sender doesn't matter — we don't verify it. Use a non-zero
  // placeholder for cleanliness.
  const sender = pad('0x01', { size: 20 });
  const r = await fetch(`${GATEWAY}/lookup/${sender}/${data}.json`);
  const body = (await r.json()) as { data?: Hex; error?: string };
  if (!r.ok || !body.data) {
    throw new Error(`gateway ${r.status}: ${body.error ?? JSON.stringify(body)}`);
  }
  return body.data;
}

function decodeText(value: Hex): string {
  return decodeAbiParameters([{ type: 'string' }], value)[0];
}

function decodeAddr(value: Hex): Hex {
  return decodeAbiParameters([{ type: 'address' }], value)[0];
}

async function ensureCriticalSeeded() {
  // Re-submit the smoke signals if the applet was restarted between
  // signal-api smoke and gateway smoke.
  const seeds = [
    ['watcher-sourcify.argus.eth', { source: 'sourcify', finding: 'arbitrary-call in execute()' }, 90],
    ['watcher-onchain.argus.eth', { source: 'on-chain', finding: 'OwnershipTransferred to fresh EOA' }, 80],
    ['scout-apify.argus.eth', { source: 'apify', finding: 'tweet from peckshield' }, 75],
  ] as const;
  for (const [submitter, evidence, reputation] of seeds) {
    await fetch(`${SIGNAL_API}/signals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contractAddress: ADDR,
        chainId: 11155111,
        threatType: 'SWAT-001',
        verdict: 'CONFIRMED',
        evidence,
        submitter,
        reputation,
      }),
    });
  }
}

async function main() {
  console.log('0. /health');
  console.log(JSON.stringify(await (await fetch(`${GATEWAY}/health`)).json()));

  console.log('\n1. seed signals via signal-api (idempotent)');
  await ensureCriticalSeeded();

  console.log('\n2. lookup text("score")');
  const score = decodeText(await lookup(buildTextCallData(FULL_NAME, 'score')));
  console.log(`   → ${JSON.stringify(score)}`);
  if (score !== 'CRITICAL') throw new Error(`expected CRITICAL, got ${score}`);

  console.log('\n3. lookup text("confidence")');
  const conf = decodeText(
    await lookup(buildTextCallData(FULL_NAME, 'confidence')),
  );
  console.log(`   → ${JSON.stringify(conf)}`);
  if (Number(conf) <= 0) throw new Error(`expected confidence > 0, got ${conf}`);

  console.log('\n4. lookup text("attestation")');
  const att = decodeText(
    await lookup(buildTextCallData(FULL_NAME, 'attestation')),
  );
  console.log(`   → ${att.slice(0, 22)}...`);
  if (!att.startsWith('0x')) throw new Error(`bad attestation: ${att}`);

  console.log('\n5. lookup text("url")');
  const url = decodeText(await lookup(buildTextCallData(FULL_NAME, 'url')));
  console.log(`   → ${url}`);
  if (!url.includes(ADDR)) throw new Error(`url missing addr: ${url}`);

  console.log('\n6. lookup addr()');
  const a = decodeAddr(await lookup(buildAddrCallData(FULL_NAME)));
  console.log(`   → ${a}`);
  if (a.toLowerCase() !== ADDR.toLowerCase()) {
    throw new Error(`addr mismatch: ${a} vs ${ADDR}`);
  }

  console.log('\n7. unknown text key returns ""');
  const unknown = decodeText(
    await lookup(buildTextCallData(FULL_NAME, 'definitely-not-a-key')),
  );
  console.log(`   → ${JSON.stringify(unknown)}`);
  if (unknown !== '') throw new Error(`expected empty, got ${unknown}`);

  console.log('\n8. /preview/:addr');
  const prev = (await (await fetch(`${GATEWAY}/preview/${ADDR}`)).json()) as {
    records: Record<string, string>;
  };
  console.log(JSON.stringify(prev.records, null, 2));
  if (prev.records.score !== 'CRITICAL') {
    throw new Error('preview score mismatch');
  }

  console.log('\nOK');
}

await main();
