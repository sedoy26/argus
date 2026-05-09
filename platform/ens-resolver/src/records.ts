// ENS record-query decode/encode for the CCIP-Read gateway.
//
// The gateway receives `callData` — the original ABI-encoded call the
// client made to the resolver. For wildcard resolution we have to handle
// at least:
//   text(bytes32 node, string key)         selector 0x59d1d43c
//   addr(bytes32 node)                     selector 0x3b3b57de
//
// Anything else: return empty bytes (per ENSIP-10 conventions).

import type { Hex } from 'viem';
import {
  decodeAbiParameters,
  encodeAbiParameters,
  slice,
  toFunctionSelector,
} from 'viem';

export const TEXT_SELECTOR = toFunctionSelector('text(bytes32,string)');
export const ADDR_SELECTOR = toFunctionSelector('addr(bytes32)');
export const ADDR_COIN_SELECTOR = toFunctionSelector('addr(bytes32,uint256)');

export type Query =
  | { kind: 'text'; node: Hex; key: string }
  | { kind: 'addr'; node: Hex }
  | { kind: 'unsupported'; selector: Hex };

export function decodeQuery(callData: Hex): Query {
  const sel = slice(callData, 0, 4);
  const args = slice(callData, 4) as Hex;

  if (sel === TEXT_SELECTOR) {
    const [node, key] = decodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'string' }],
      args,
    );
    return { kind: 'text', node, key };
  }

  if (sel === ADDR_SELECTOR) {
    const [node] = decodeAbiParameters([{ type: 'bytes32' }], args);
    return { kind: 'addr', node };
  }

  // ENSIP-9 multi-coin form. For coin 60 (ETH) we treat it the same as
  // legacy addr(); other coins fall through to unsupported.
  if (sel === ADDR_COIN_SELECTOR) {
    const [node, coin] = decodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }],
      args,
    );
    if (coin === 60n) return { kind: 'addr', node };
    return { kind: 'unsupported', selector: sel };
  }

  return { kind: 'unsupported', selector: sel };
}

/** Encode the value to return for a `text(...)` call. */
export function encodeText(value: string): Hex {
  return encodeAbiParameters([{ type: 'string' }], [value]);
}

/** Encode the value to return for an `addr(...)` call. */
export function encodeAddr(value: Hex): Hex {
  return encodeAbiParameters([{ type: 'address' }], [value]);
}

/** Encode an empty string (the "no record" sentinel for text). */
export const EMPTY_TEXT = encodeText('');

/** Encode the zero address (the "no record" sentinel for addr). */
export const EMPTY_ADDR = encodeAddr('0x0000000000000000000000000000000000000000');
