import { beforeAll, describe, expect, test } from 'bun:test';
import { callApplet, preflight, setupApplet } from '../../scripts/test-helpers';

// The Attest applet passes the raw JSON-RPC reply from the Trusted OS
// back to the host verbatim. Shape (on real hardware):
//   {"id":1,"result":{"DerivedKey":"<base64>","Error":""},"error":null}
// Under QEMU emulation there is no DCP/CAAM, so the result has Error set
// instead — the assertions below verify that "degrade gracefully" path,
// which still proves the bridge → applet → RPC chain works end-to-end.
//
// To run the same suite against real hardware (where DerivedKey *will*
// be set), see docs/PORTING_TO_USBARMORY.md.
function parseAttest(raw: string): { key: string; error: string } {
  const rpc = JSON.parse(raw);
  const result = rpc.result ?? {};
  return {
    key: result.DerivedKey ?? '',   // base64 (Go's default []byte encoding)
    error: result.Error ?? '',
  };
}

describe('Attestation applet (QEMU)', () => {
  beforeAll(async () => {
    await preflight();
    await setupApplet('attestation');
  }, 180_000);

  test('round-trips through the bridge with the expected JSON shape', async () => {
    const raw = await callApplet('Attest', '');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('result');
    const { key, error } = parseAttest(raw);
    // Exactly one of (key, error) is non-empty. On QEMU it's error.
    expect(Boolean(key) !== Boolean(error)).toBe(true);
  });

  test('reports the expected emulation Error string', async () => {
    const raw = await callApplet('Attest', '');
    const { error } = parseAttest(raw);
    expect(error).toContain('emulation');
  });
});
