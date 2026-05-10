/**
 * Argus demo contracts, registry, and contributor flows are **Sepolia-only**.
 * Wallets often default to Polygon or Mainnet — we switch (or add) Sepolia before
 * signatures and on-chain writes so RPC + chain state stay consistent.
 */

import { numberToHex } from 'viem';
import { sepolia } from 'viem/chains';
import type { Eip1193Like } from './walletProvider';

const SEPOLIA_HEX = numberToHex(sepolia.id);

function addSepoliaParams() {
  const rpc = sepolia.rpcUrls.default.http[0];
  const explorer = sepolia.blockExplorers?.default?.url;
  return {
    chainId: SEPOLIA_HEX,
    chainName: sepolia.name,
    nativeCurrency: sepolia.nativeCurrency,
    rpcUrls: [rpc],
    blockExplorerUrls: explorer ? [explorer] : undefined,
  };
}

/** Current wallet RPC chain id, or 0 if unreadable. */
export async function readWalletChainId(eth: Eip1193Like): Promise<number> {
  try {
    const hex = (await eth.request({ method: 'eth_chainId' })) as unknown;
    if (typeof hex !== 'string' || !hex.startsWith('0x')) return 0;
    return Number.parseInt(hex.slice(2), 16);
  } catch {
    return 0;
  }
}

/**
 * Prompts `wallet_switchEthereumChain` to Sepolia, or `wallet_addEthereumChain` if missing.
 * Throws a clear error if the user rejects or the wallet cannot switch.
 */
export async function ensureSepoliaChain(eth: Eip1193Like): Promise<void> {
  const current = await readWalletChainId(eth);
  if (current === sepolia.id) return;

  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: SEPOLIA_HEX }],
    });
  } catch (e: unknown) {
    const code = (e as { code?: number })?.code;
    if (code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [addSepoliaParams()],
      });
      try {
        await eth.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: SEPOLIA_HEX }],
        });
      } catch {
        /* some wallets select Sepolia automatically after add */
      }
    } else {
      throw new Error(
        'Argus runs on Ethereum Sepolia (chain 11155111). Switch network in your wallet and try again.',
      );
    }
  }

  const after = await readWalletChainId(eth);
  if (after !== sepolia.id) {
    throw new Error(
      'Wallet is not on Sepolia — contributor requests and registry actions only work on chain 11155111.',
    );
  }
}
