// On-chain watcher smoke — Anvil-backed.
//
//   1. Boot Anvil on :8546.
//   2. Deploy FakeSwapNet from the forge artifacts (now Ownable).
//   3. Construct a fresh EOA (zero balance, zero nonce) as the
//      "compromised admin".
//   4. Owner transfers ownership to the fresh EOA.
//   5. Watcher.sweep() picks up the OwnershipTransferred event, runs
//      heuristics, submits SWAT-002 to signal-api.
//   6. /risk/:addr now lists SWAT-002:CONFIRMED in its summary.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

import { Watcher } from '../src/watcher.ts';

const ANVIL_PORT = Number(Bun.env.ANVIL_PORT ?? 8546);
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
// Anvil account 0 — well-known prefunded key.
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const SIGNAL_API = Bun.env.ARGUS_API ?? 'http://127.0.0.1:8787';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = join(HERE, '../../../contracts/out');

const chain = defineChain({
  id: 31337,
  name: 'Anvil-localhost',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
});

async function startAnvil(): Promise<{ kill: () => void }> {
  const proc = Bun.spawn(['anvil', '--port', String(ANVIL_PORT), '--silent']);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(ANVIL_RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (r.ok) return { kill: () => proc.kill() };
    } catch {
      /* retry */
    }
    await Bun.sleep(200);
  }
  proc.kill();
  throw new Error(`anvil did not come up on ${ANVIL_RPC}`);
}

interface ForgeArtifact {
  abi: readonly unknown[];
  bytecode: { object: Hex };
}

function loadArtifact(name: string): ForgeArtifact {
  const path = join(ARTIFACT_ROOT, `${name}.sol`, `${name}.json`);
  const j = JSON.parse(readFileSync(path, 'utf8')) as {
    abi: readonly unknown[];
    bytecode: { object: string };
  };
  return { abi: j.abi, bytecode: { object: j.bytecode.object as Hex } };
}

async function main() {
  console.log('1. boot anvil');
  const anvil = await startAnvil();
  try {
    const account = privateKeyToAccount(PK);
    const wallet = createWalletClient({ account, chain, transport: http(ANVIL_RPC) });
    const pub = createPublicClient({ chain, transport: http(ANVIL_RPC) });

    console.log('2. deploy FakeSwapNet (Ownable)');
    const swapArt = loadArtifact('FakeSwapNet');
    const swapDeploy = await wallet.deployContract({
      abi: swapArt.abi,
      bytecode: swapArt.bytecode.object,
    });
    const swapRcpt = await pub.waitForTransactionReceipt({ hash: swapDeploy });
    const swap = swapRcpt.contractAddress! as Address;
    console.log(`   FakeSwapNet ${swap} (deployed at block ${swapRcpt.blockNumber})`);

    console.log('3. mint a fresh EOA as the "compromised admin"');
    const freshKey = generatePrivateKey();
    const freshAcct = privateKeyToAccount(freshKey);
    console.log(`   freshAdmin ${freshAcct.address}`);
    const balanceBefore = await pub.getBalance({ address: freshAcct.address });
    const txCountBefore = await pub.getTransactionCount({ address: freshAcct.address });
    console.log(`     balance=${balanceBefore} txCount=${txCountBefore}`);
    if (balanceBefore !== 0n || txCountBefore !== 0) {
      throw new Error('expected fresh EOA');
    }

    console.log('4. transferOwnership → freshAdmin');
    const transferTx = await wallet.sendTransaction({
      to: swap,
      data: encodeFunctionData({
        abi: swapArt.abi,
        functionName: 'transferOwnership',
        args: [freshAcct.address],
      }),
    });
    await pub.waitForTransactionReceipt({ hash: transferTx });
    console.log(`   tx ${transferTx}`);

    console.log('5. watcher.sweep()');
    const watcher = new Watcher({
      client: pub,
      targets: [{ chainId: 31337, address: swap, label: 'fake-swap' }],
      signalApi: SIGNAL_API,
      submitter: 'watcher-onchain.argus.eth',
      maxReputation: 80,
      pollMs: 100_000,
      fromBlock: 0n,
    });
    const subs = await watcher.sweep();
    console.log(`   submissions=${subs.length}`);
    for (const s of subs) {
      if (!s.ok) throw new Error(`submission failed: ${s.error ?? s.status}`);
      console.log(`     → ${s.consensus?.score}`);
    }
    if (subs.length !== 1) {
      throw new Error(`expected 1 submission, got ${subs.length}`);
    }

    console.log('6. /risk/:addr reflects SWAT-002');
    const risk = (await (await fetch(`${SIGNAL_API}/risk/${swap}`)).json()) as {
      score: string;
      summary: string;
      confirmed: number;
    };
    console.log(`   score=${risk.score} confirmed=${risk.confirmed}`);
    console.log(`   summary=${risk.summary}`);
    if (!risk.summary.includes('SWAT-002')) {
      throw new Error('SWAT-002 missing from summary');
    }

    console.log('7. dedup — second sweep submits nothing new');
    const second = await watcher.sweep();
    console.log(`   submissions=${second.length}`);
    if (second.length !== 0) throw new Error('dedup failed');

    console.log('\nOK');
  } finally {
    anvil.kill();
  }
}

await main();
