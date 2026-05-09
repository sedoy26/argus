// DNS wire-format <-> label list, for ENS names.
//
// ENS uses RFC1035 DNS encoding for `resolve(name, data)`. Each label is
// length-prefixed; the name terminates with a zero byte:
//   "0xabc.risks.argus.eth"
//   → 0x2a "0xabc..." 0x05 "risks" 0x05 "argus" 0x03 "eth" 0x00

import type { Hex } from 'viem';
import { hexToBytes, bytesToHex } from 'viem';

export function decodeName(dnsHex: Hex): string[] {
  const bytes = hexToBytes(dnsHex);
  const labels: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i]!;
    if (len === 0) break;
    if (i + 1 + len > bytes.length) {
      throw new Error('truncated DNS name');
    }
    const slice = bytes.slice(i + 1, i + 1 + len);
    labels.push(new TextDecoder().decode(slice));
    i += 1 + len;
  }
  return labels;
}

export function encodeName(labels: string[]): Hex {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const label of labels) {
    const b = enc.encode(label);
    if (b.length > 255) throw new Error(`label too long: ${label}`);
    parts.push(new Uint8Array([b.length]), b);
  }
  parts.push(new Uint8Array([0]));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return bytesToHex(out);
}
