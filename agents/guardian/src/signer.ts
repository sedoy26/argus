// Signer abstraction.
//
// LocalSigner — viem privateKeyToAccount; the dev fallback used in
// every smoke test. Fast, deterministic, no external dependencies.
//
// KmsSigner — SpaceComputer Orbitport KMS. The key is generated and
// held inside the KMS; this process never sees its raw bytes. We pass
// the keccak-256 digest of an unsigned EIP-1559 / legacy transaction
// to `kms.sign({ messageType: "DIGEST", signingAlgorithm:
// "ETHEREUM_SECP256K1" })`, decode the 65-byte (r||s||v) signature,
// and reassemble the signed envelope locally.
//
// On real USB Armory hardware the same pattern applies: a session key
// scoped at the smart-wallet layer (ERC-4337) restricts what this
// signer can do, so even if the KMS is somehow compromised the
// on-chain wallet rejects unauthorized actions.

import {
  type Address,
  type Hex,
  type TransactionSerializable,
  fromHex,
  hexToBytes,
  keccak256,
  recoverAddress,
  serializeTransaction,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { fromBase64ToUint8Array, OrbitportSDK } from '@spacecomputer-io/orbitport-sdk-ts';

import type { Signer } from './types.ts';

// ---------------------------------------------------------------------------
// LocalSigner — for development and CI
// ---------------------------------------------------------------------------

export class LocalSigner implements Signer {
  readonly address: Address;
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }

  async signTransaction(tx: TransactionSerializable): Promise<Hex> {
    return this.account.signTransaction(tx);
  }
}

// ---------------------------------------------------------------------------
// KmsSigner — for production via SpaceComputer Orbitport
// ---------------------------------------------------------------------------

export interface KmsSignerOptions {
  clientId: string;
  clientSecret: string;
  keyId: string;
  /** Address corresponding to the KMS key. If omitted we try to
   *  recover it from the first signature; supplying it explicitly
   *  saves a round-trip. */
  address?: Address;
  /** Custom OAuth domain / API URL — useful for staging. */
  authDomain?: string;
  apiUrl?: string;
}

export class KmsSigner implements Signer {
  readonly address: Address;
  private readonly sdk: OrbitportSDK;
  private readonly keyId: string;

  private constructor(sdk: OrbitportSDK, keyId: string, address: Address) {
    this.sdk = sdk;
    this.keyId = keyId;
    this.address = address;
  }

  static async connect(opts: KmsSignerOptions): Promise<KmsSigner> {
    const sdk = new OrbitportSDK({
      config: {
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        authDomain: opts.authDomain,
        apiUrl: opts.apiUrl,
      },
    });

    let address = opts.address;
    if (!address) {
      // Recover by signing a known message and reversing it. We use
      // EIP-191 personal_sign because the SDK exposes that messageType
      // first-class for ETHEREUM keys, and recoverAddress handles the
      // "\x19Ethereum Signed Message" prefix automatically.
      const probe = `argus-guardian-key-recovery-${Date.now()}`;
      const sigB64 = (
        await sdk.kms.sign({
          keyId: opts.keyId,
          message: probe,
          signingAlgorithm: 'ETHEREUM_SECP256K1',
          messageType: 'EIP191',
        })
      ).data.Signature;
      const sig = bytesToHex(fromBase64ToUint8Array(sigB64));
      address = await recoverAddress({
        hash: hashEip191(probe),
        signature: sig,
      });
    }

    return new KmsSigner(sdk, opts.keyId, address);
  }

  async signTransaction(tx: TransactionSerializable): Promise<Hex> {
    const unsigned = serializeTransaction(tx);
    const digest = keccak256(unsigned);

    const sigB64 = (
      await this.sdk.kms.sign({
        keyId: this.keyId,
        message: hexToBytes(digest),
        signingAlgorithm: 'ETHEREUM_SECP256K1',
        messageType: 'DIGEST',
      })
    ).data.Signature;

    const raw = fromBase64ToUint8Array(sigB64);
    if (raw.length !== 65) {
      throw new Error(`KMS returned ${raw.length}-byte signature; expected 65`);
    }
    const r = bytesToHex(raw.slice(0, 32));
    const s = bytesToHex(raw.slice(32, 64));
    const vRaw = raw[64]!;
    const yParity: 0 | 1 = vRaw === 0 || vRaw === 27 ? 0 : 1;

    // Pre-EIP-1559 (legacy + EIP-2930) needs `v` (uint), EIP-1559+ needs
    // `yParity`. Pass both — viem's serializeTransaction picks what
    // applies.
    const sig = { r, s, yParity, v: BigInt(yParity === 0 ? 27 : 28) };
    return serializeTransaction(tx, sig);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): Hex {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s as Hex;
}

function hashEip191(message: string): Hex {
  const prefix = `Ethereum Signed Message:\n${message.length}`;
  const enc = new TextEncoder();
  const buf = new Uint8Array(prefix.length + message.length);
  buf.set(enc.encode(prefix), 0);
  buf.set(enc.encode(message), prefix.length);
  return keccak256(bytesToHex(buf));
}

// ---------------------------------------------------------------------------
// Factory: pick a signer by env
// ---------------------------------------------------------------------------

/** Build a signer from process env. Returns LocalSigner if
 *  `GUARDIAN_PRIVATE_KEY` is set, otherwise KmsSigner if
 *  `ORBITPORT_CLIENT_ID` + `ORBITPORT_CLIENT_SECRET` + `KMS_KEY_ID`
 *  are all set. Errors loudly if neither path is fully configured. */
export async function signerFromEnv(): Promise<Signer> {
  const pk = Bun.env.GUARDIAN_PRIVATE_KEY;
  if (pk) {
    if (!pk.startsWith('0x') || pk.length !== 66) {
      throw new Error('GUARDIAN_PRIVATE_KEY must be a 0x-prefixed 32-byte hex');
    }
    return new LocalSigner(pk as Hex);
  }
  const clientId = Bun.env.ORBITPORT_CLIENT_ID;
  const clientSecret = Bun.env.ORBITPORT_CLIENT_SECRET;
  const keyId = Bun.env.KMS_KEY_ID;
  if (clientId && clientSecret && keyId) {
    return KmsSigner.connect({
      clientId,
      clientSecret,
      keyId,
      address: Bun.env.KMS_KEY_ADDRESS as Address | undefined,
      authDomain: Bun.env.ORBITPORT_AUTH_DOMAIN,
      apiUrl: Bun.env.ORBITPORT_API_URL,
    });
  }
  throw new Error(
    'Configure either GUARDIAN_PRIVATE_KEY or ' +
      'ORBITPORT_CLIENT_ID + ORBITPORT_CLIENT_SECRET + KMS_KEY_ID',
  );
}
// Suppress unused-import lint when fromHex is referenced only by JSDoc
// in the future.
void fromHex;
