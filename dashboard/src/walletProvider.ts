/**
 * Tracks which EIP-1193 provider the user picked so we don't always hit
 * `window.ethereum` (often a multiplexer that prefers Rainbow over MetaMask).
 */

export type Eip1193Like = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export type WalletOption = {
  id: string;
  name: string;
  icon?: string;
  provider: Eip1193Like;
};

let active: Eip1193Like | null = null;

export function setActiveEthereumProvider(p: Eip1193Like | null): void {
  active = p;
}

export function clearActiveEthereumProvider(): void {
  active = null;
}

/** Returns the user-selected EIP-1193 provider (set at connect / session rebind). */
export function getActiveEthereumProvider(): Eip1193Like | undefined {
  return active ?? undefined;
}

type AnnounceDetail = {
  info: { uuid: string; name: string; icon?: string; rdns?: string };
  provider: Eip1193Like;
};

function labelLegacyProvider(p: unknown, index: number): string {
  if (!p || typeof p !== 'object') return `Wallet ${index + 1}`;
  const o = p as Record<string, unknown>;
  if (o.isBraveWallet) return 'Brave Wallet';
  if (o.isMetaMask && !o.isBraveWallet) return 'MetaMask';
  if (o.isRainbowWallet) return 'Rainbow';
  if (o.isCoinbaseWallet) return 'Coinbase Wallet';
  if (o.isRabby) return 'Rabby';
  return `Injected wallet ${index + 1}`;
}

function dedupeByProviderReference(opts: WalletOption[]): WalletOption[] {
  const seen = new WeakSet<object>();
  const out: WalletOption[] = [];
  for (const o of opts) {
    const ref = o.provider as object;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(o);
  }
  return out;
}

const NAME_ORDER = ['metamask', 'rabby', 'rainbow', 'coinbase', 'brave'];

function sortWalletOptions(opts: WalletOption[]): WalletOption[] {
  return [...opts].sort((a, b) => {
    const la = a.name.toLowerCase();
    const lb = b.name.toLowerCase();
    const ia = NAME_ORDER.findIndex((k) => la.includes(k));
    const ib = NAME_ORDER.findIndex((k) => lb.includes(k));
    const sa = ia === -1 ? 999 : ia;
    const sb = ib === -1 ? 999 : ib;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });
}

/**
 * EIP-6963 discovery plus `ethereum.providers` / single `ethereum` fallback.
 * Waits briefly for announce events after requesting providers.
 */
export async function discoverWalletOptions(): Promise<WalletOption[]> {
  if (typeof window === 'undefined') return [];

  const raw: WalletOption[] = [];

  await new Promise<void>((resolve) => {
    const seenUuids = new Set<string>();
    const onAnnounce = (ev: Event) => {
      const ce = ev as CustomEvent<AnnounceDetail>;
      const d = ce.detail;
      if (!d?.info?.uuid || !d.provider || typeof d.provider.request !== 'function') return;
      if (seenUuids.has(d.info.uuid)) return;
      seenUuids.add(d.info.uuid);
      raw.push({
        id: d.info.uuid,
        name: d.info.name || d.info.rdns || 'Wallet',
        icon: d.info.icon,
        provider: d.provider,
      });
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce as EventListener);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    window.setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce as EventListener);
      resolve();
    }, 500);
  });

  const eth = (window as unknown as {
    ethereum?: Eip1193Like & {
      providers?: unknown[];
    };
  }).ethereum;

  if (eth?.providers && Array.isArray(eth.providers)) {
    eth.providers.forEach((p, i) => {
      if (!p || typeof p !== 'object') return;
      const pr = p as Eip1193Like;
      if (typeof pr.request !== 'function') return;
      raw.push({
        id: `legacy-${i}`,
        name: labelLegacyProvider(p, i),
        provider: pr,
      });
    });
  }

  if (eth && typeof eth.request === 'function') {
    const already = raw.some((o) => o.provider === eth);
    if (!already) {
      raw.push({
        id: 'window-ethereum',
        name: labelLegacyProvider(eth, 0),
        provider: eth,
      });
    }
  }

  return sortWalletOptions(dedupeByProviderReference(raw));
}
