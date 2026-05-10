// X402 payment signing for Apify (USDC on Base). Copied from scout-apify;
// see https://docs.apify.com/platform/integrations/x402

import { type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

const ERC3009_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: USDC_BASE,
} as const;

const ERC3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

interface AcceptedPayment {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource?: { url: string; description?: string };
  accepts: AcceptedPayment[];
}

function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ('0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

/** Human-readable USDC amount (6 decimals) for dashboard / feed detail. */
function formatUsdc6Units(raw: bigint): string {
  const n = Number(raw) / 1e6;
  if (!Number.isFinite(n)) return String(raw);
  return n.toFixed(6).replace(/\.?0+$/, '') || '0';
}

export type X402SignedPayment = {
  paymentSignatureB64: string;
  /** e.g. "1" or "0.5" — smallest units / 1e6 */
  usdcAmount: string;
  /** raw atomic string from Apify challenge */
  atomicAmount: string;
};

export async function signX402Payment(
  paymentRequiredB64: string,
  privateKey: Hex,
): Promise<X402SignedPayment | null> {
  const paymentRequiredJson = Buffer.from(paymentRequiredB64, 'base64').toString('utf-8');
  const paymentRequired = JSON.parse(paymentRequiredJson) as PaymentRequired;

  const accepted = paymentRequired.accepts.find(
    (a) => a.network.startsWith('eip155:') && a.scheme === 'exact',
  );
  if (!accepted) {
    console.warn('[x402] no EVM exact-scheme payment option found in 402 response');
    return null;
  }

  const account = privateKeyToAccount(privateKey);
  const nonce = randomNonce();
  const validAfter = BigInt(0);
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + accepted.maxTimeoutSeconds);
  const value = BigInt(accepted.amount);
  const usdcAmount = formatUsdc6Units(value);

  const signature = await account.signTypedData({
    domain: ERC3009_DOMAIN,
    types: ERC3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: account.address,
      to: accepted.payTo as Hex,
      value,
      validAfter,
      validBefore,
      nonce,
    },
  });

  const payload = {
    x402Version: 2,
    scheme: 'exact',
    network: accepted.network,
    accepted: {
      scheme: accepted.scheme,
      network: accepted.network,
      amount: accepted.amount,
      asset: accepted.asset,
      payTo: accepted.payTo,
      maxTimeoutSeconds: accepted.maxTimeoutSeconds,
      ...(accepted.extra && { extra: accepted.extra }),
    },
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
    extensions: {},
  };

  return {
    paymentSignatureB64: Buffer.from(JSON.stringify(payload)).toString('base64'),
    usdcAmount,
    atomicAmount: accepted.amount,
  };
}

export type X402FetchMeta = { usdcAmount: string; atomicAmount: string };

export async function fetchWithX402(
  url: string,
  init: RequestInit,
  privateKey: Hex,
): Promise<{ response: Response; payment?: X402FetchMeta }> {
  const firstHeaders: Record<string, string> = {
    ...(init.headers as Record<string, string>),
    'X-APIFY-PAYMENT-PROTOCOL': 'X402',
  };

  const firstRes = await fetch(url, { ...init, headers: firstHeaders });

  if (firstRes.status !== 402) {
    return { response: firstRes };
  }

  const paymentRequiredB64 = firstRes.headers.get('PAYMENT-REQUIRED');
  if (!paymentRequiredB64) {
    throw new Error('[x402] 402 response missing PAYMENT-REQUIRED header');
  }

  console.log('[signal-api x402] 402 received — signing USDC payment…');
  const signed = await signX402Payment(paymentRequiredB64, privateKey);
  if (!signed) {
    throw new Error('[x402] could not sign payment');
  }

  const secondHeaders: Record<string, string> = {
    ...(init.headers as Record<string, string>),
    'X-APIFY-PAYMENT-PROTOCOL': 'X402',
    'PAYMENT-SIGNATURE': signed.paymentSignatureB64,
  };

  const response = await fetch(url, { ...init, headers: secondHeaders });
  return {
    response,
    payment: { usdcAmount: signed.usdcAmount, atomicAmount: signed.atomicAmount },
  };
}

export type X402Settlement = {
  success?: boolean;
  network?: string;
  /** Apify PAYMENT-RESPONSE settlement hash / id */
  transaction?: string;
  tx?: string;
};

export function parseX402Settlement(res: Response): X402Settlement {
  const paymentResponseB64 = res.headers.get('PAYMENT-RESPONSE');
  if (!paymentResponseB64) return {};
  try {
    return JSON.parse(Buffer.from(paymentResponseB64, 'base64').toString('utf-8')) as X402Settlement;
  } catch {
    return {};
  }
}
