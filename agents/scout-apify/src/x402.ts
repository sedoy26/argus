// X402 payment signing for Apify actors.
//
// The x402 protocol flow (https://payai.mintlify.app/x402/clients/typescript/manual-flow):
//   1. Call Apify with X-APIFY-PAYMENT-PROTOCOL: X402 (no payment)
//   2. API returns 402 + PAYMENT-REQUIRED header (base64-encoded JSON)
//   3. Parse requirements → find eip155:8453 (USDC on Base mainnet)
//   4. Sign ERC-3009 TransferWithAuthorization via EIP-712 using viem
//   5. Base64-encode payment payload → PAYMENT-SIGNATURE header
//   6. Retry with PAYMENT-SIGNATURE → get results
//
// ENV required: ARGUS_X402_PRIVATE_KEY (hex private key, wallet funded with USDC on Base)
//
// USDC on Base mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
// Minimum payment:      $1 USDC (1_000_000 smallest units, 6 decimals)

import { type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

const ERC3009_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453, // Base mainnet
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

function formatUsdc6Units(raw: bigint): string {
  const n = Number(raw) / 1e6;
  if (!Number.isFinite(n)) return String(raw);
  return n.toFixed(6).replace(/\.?0+$/, '') || '0';
}

export type X402SignedPayment = {
  paymentSignatureB64: string;
  usdcAmount: string;
  atomicAmount: string;
};

/**
 * Given the PAYMENT-REQUIRED header value (base64-encoded JSON), produce the
 * PAYMENT-SIGNATURE payload by signing with the provided private key.
 */
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

  const paymentSignatureB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  console.log(
    `[x402] signed payment: ${usdcAmount} USDC → ${accepted.payTo.slice(0, 10)}… on ${accepted.network}`,
  );
  return { paymentSignatureB64, usdcAmount, atomicAmount: accepted.amount };
}

export type X402FetchMeta = { usdcAmount: string; atomicAmount: string };

/**
 * Wraps a fetch call with the X402 handshake for Apify.
 *
 * Sends the initial request with X-APIFY-PAYMENT-PROTOCOL: X402.
 * If 402 is received, signs the payment and retries with PAYMENT-SIGNATURE.
 */
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

  console.log('[x402] 402 received — signing payment…');
  const signed = await signX402Payment(paymentRequiredB64, privateKey);
  if (!signed) {
    throw new Error('[x402] could not sign payment (no compatible payment option in 402)');
  }

  const secondHeaders: Record<string, string> = {
    ...(init.headers as Record<string, string>),
    'X-APIFY-PAYMENT-PROTOCOL': 'X402',
    'PAYMENT-SIGNATURE': signed.paymentSignatureB64,
  };

  const secondRes = await fetch(url, { ...init, headers: secondHeaders });

  // Log settlement info if present
  const paymentResponseB64 = secondRes.headers.get('PAYMENT-RESPONSE');
  if (paymentResponseB64) {
    try {
      const settlement = JSON.parse(Buffer.from(paymentResponseB64, 'base64').toString('utf-8')) as {
        success?: boolean;
        transaction?: string;
        network?: string;
        payer?: string;
      };
      if (settlement.success) {
        console.log(`[x402] payment settled: tx=${(settlement.transaction ?? '—').slice(0, 14)}… on ${settlement.network}`);
      }
    } catch {
      /* ignore parse errors */
    }
  }

  return {
    response: secondRes,
    payment: { usdcAmount: signed.usdcAmount, atomicAmount: signed.atomicAmount },
  };
}
