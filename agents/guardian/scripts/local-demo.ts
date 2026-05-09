// Guardian local smoke — Anvil-backed, no testnet required.
//
//   1. Boot a fresh Anvil on port 8546.
//   2. Deploy MockUSDC + FakeSwapNet using the artifacts forge built
//      under contracts/out/.
//   3. Have the test account approve FakeSwapNet for max USDC.
//   4. Submit signals to signal-api so its risk score escalates to
//      CRITICAL.
//   5. Run Guardian.revokeAll() once and verify the allowance is now 0.
//   6. Replay the attacker step (FakeSwapNet.execute(usdc,
//      transferFrom(...))) and verify it reverts.
//
// Prereqs: signal-api on :8787 + applet on :4000. Forge artifacts must
// exist (`forge build` in contracts/).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { Guardian } from '../src/guardian.ts';
import { LocalSigner } from '../src/signer.ts';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ANVIL_PORT = Number(Bun.env.ANVIL_PORT ?? 8546);
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
// Anvil's default account 0 — well-known prefunded key.
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const ATTACKER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const SIGNAL_API = Bun.env.ARGUS_API ?? 'http://127.0.0.1:8787';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = join(HERE, '../../../contracts/out');

const anvilChain = defineChain({
  id: 31337,
  name: 'Anvil-localhost',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
});

// ---------------------------------------------------------------------------
// Anvil bootstrapper
// ---------------------------------------------------------------------------

async function startAnvil(): Promise<{ kill: () => void }> {
  const proc = Bun.spawn(['anvil', '--port', String(ANVIL_PORT), '--silent']);
  // Poll until JSON-RPC answers.
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

// ---------------------------------------------------------------------------
// Artifact loader
// ---------------------------------------------------------------------------

interface ForgeArtifact {
  abi: readonly unknown[];
  bytecode: { object: Hex };
}

function loadArtifact(name: string): ForgeArtifact {
  const path = join(ARTIFACT_ROOT, `${name}.sol`, `${name}.json`);
  const raw = readFileSync(path, 'utf8');
  const j = JSON.parse(raw) as {
    abi: readonly unknown[];
    bytecode: { object: string };
  };
  if (!j.bytecode.object?.startsWith('0x')) {
    throw new Error(`bad bytecode for ${name}: ${path}`);
  }
  return { abi: j.abi, bytecode: { object: j.bytecode.object as Hex } };
}

// ---------------------------------------------------------------------------
// Signal seeding
// ---------------------------------------------------------------------------

async function seedCritical(addr: string): Promise<void> {
  const seeds = [
    ['watcher-sourcify.argus.eth', { source: 'sourcify', finding: 'arbitrary-call in execute()' }, 90],
    ['watcher-onchain.argus.eth', { source: 'on-chain', finding: 'OwnershipTransferred to fresh EOA' }, 80],
    ['scout-apify.argus.eth', { source: 'apify', finding: 'tweet from peckshield' }, 75],
  ] as const;
  for (const [submitter, evidence, reputation] of seeds) {
    const r = await fetch(`${SIGNAL_API}/signals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contractAddress: addr,
        chainId: 31337,
        threatType: 'SWAT-001',
        verdict: 'CONFIRMED',
        evidence,
        submitter,
        reputation,
      }),
    });
    if (!r.ok) throw new Error(`signal-api ${r.status}: ${await r.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

async function main() {
  console.log('1. boot anvil');
  const anvil = await startAnvil();
  try {
    const account = privateKeyToAccount(PK);
    const attacker = privateKeyToAccount(ATTACKER_PK);
    const wallet = createWalletClient({
      account,
      chain: anvilChain,
      transport: http(ANVIL_RPC),
    });
    const attackerWallet = createWalletClient({
      account: attacker,
      chain: anvilChain,
      transport: http(ANVIL_RPC),
    });
    const pub = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });

    console.log('2. deploy contracts');
    const usdcArt = loadArtifact('MockUSDC');
    const swapArt = loadArtifact('FakeSwapNet');

    const usdcDeploy = await wallet.deployContract({
      abi: usdcArt.abi,
      bytecode: usdcArt.bytecode.object,
    });
    const swapDeploy = await wallet.deployContract({
      abi: swapArt.abi,
      bytecode: swapArt.bytecode.object,
    });
    const usdcRcpt = await pub.waitForTransactionReceipt({ hash: usdcDeploy });
    const swapRcpt = await pub.waitForTransactionReceipt({ hash: swapDeploy });
    const usdc = usdcRcpt.contractAddress!;
    const swap = swapRcpt.contractAddress!;
    console.log(`   MockUSDC    ${usdc}`);
    console.log(`   FakeSwapNet ${swap}`);

    console.log('3. mint + approve');
    await wallet.sendTransaction({
      to: usdc,
      data: encodeFunctionData({
        abi: usdcArt.abi,
        functionName: 'mint',
        args: [account.address, parseUnits('50000', 6)],
      }),
    });
    await wallet.sendTransaction({
      to: usdc,
      data: encodeFunctionData({
        abi: usdcArt.abi,
        functionName: 'approve',
        args: [swap, 2n ** 256n - 1n],
      }),
    });
    const allowanceBefore = (await pub.readContract({
      address: usdc,
      abi: usdcArt.abi,
      functionName: 'allowance',
      args: [account.address, swap],
    })) as bigint;
    console.log(`   allowance(alice → swap) = ${allowanceBefore}`);
    if (allowanceBefore !== 2n ** 256n - 1n) {
      throw new Error(`expected max allowance, got ${allowanceBefore}`);
    }

    console.log(`4. seed CRITICAL signals on ${swap}`);
    await seedCritical(swap);
    const env = (await (await fetch(`${SIGNAL_API}/risk/${swap}`)).json()) as {
      score: string;
    };
    console.log(`   signal-api → ${env.score}`);
    if (env.score !== 'CRITICAL') throw new Error(`expected CRITICAL, got ${env.score}`);

    console.log('5. run guardian.revokeAll()');
    const signer = new LocalSigner(PK);
    const guardian = new Guardian(
      {
        spender: swap as Address,
        tokens: [usdc as Address],
        protected: [{ label: 'alice', address: account.address }],
        threshold: 'CRITICAL',
        pollMs: 100_000,
        rpcUrl: ANVIL_RPC,
      },
      signer,
    );
    const actions = await guardian.revokeAll('CRITICAL');
    console.log(`   ${actions.length} revoke tx(s) submitted`);
    for (const a of actions) {
      await pub.waitForTransactionReceipt({ hash: a.txHash as Hex });
    }

    console.log('6. verify allowance is 0');
    const allowanceAfter = (await pub.readContract({
      address: usdc,
      abi: usdcArt.abi,
      functionName: 'allowance',
      args: [account.address, swap],
    })) as bigint;
    console.log(`   allowance(alice → swap) = ${allowanceAfter}`);
    if (allowanceAfter !== 0n) throw new Error(`expected 0, got ${allowanceAfter}`);

    console.log('7. replay attacker → must revert');
    const drain = encodeFunctionData({
      abi: usdcArt.abi,
      functionName: 'transferFrom',
      args: [account.address, attacker.address, parseUnits('50000', 6)],
    });
    let attackBlocked = false;
    try {
      await attackerWallet.sendTransaction({
        to: swap,
        data: encodeFunctionData({
          abi: swapArt.abi,
          functionName: 'execute',
          args: [usdc, drain],
        }),
      });
    } catch (e) {
      attackBlocked = true;
      console.log(`   attacker reverted: ${(e as Error).message.slice(0, 80)}...`);
    }
    if (!attackBlocked) throw new Error('attacker drained funds — guardian failed');

    const aliceBal = (await pub.readContract({
      address: usdc,
      abi: usdcArt.abi,
      functionName: 'balanceOf',
      args: [account.address],
    })) as bigint;
    const attackerBal = (await pub.readContract({
      address: usdc,
      abi: usdcArt.abi,
      functionName: 'balanceOf',
      args: [attacker.address],
    })) as bigint;
    console.log(`   alice    ${aliceBal} mUSDC`);
    console.log(`   attacker ${attackerBal} mUSDC`);
    if (aliceBal !== parseUnits('50000', 6)) throw new Error('alice balance changed');
    if (attackerBal !== 0n) throw new Error('attacker got funds');

    console.log('\nOK — guardian protected the wallet');
  } finally {
    anvil.kill();
  }
}

await main();
