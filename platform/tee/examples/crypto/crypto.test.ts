import { beforeAll, describe, expect, test } from 'bun:test';
import { callApplet, preflight, setupApplet } from '../../scripts/test-helpers';

describe('Crypto applet', () => {
  beforeAll(async () => {
    await preflight();
    await setupApplet('crypto');
  }, 120_000);

  test('Random(N) returns exactly 2*N lowercase hex chars', async () => {
    const out = await callApplet('Random', '16');
    expect(out).toHaveLength(32);
    expect(out).toMatch(/^[0-9a-f]+$/);
  });

  test('Random(32) returns 64 hex chars', async () => {
    const out = await callApplet('Random', '32');
    expect(out).toHaveLength(64);
    expect(out).toMatch(/^[0-9a-f]+$/);
  });

  test('two successive calls return different bytes (entropy)', async () => {
    const a = await callApplet('Random', '32');
    const b = await callApplet('Random', '32');
    // Probability of a 32-byte collision from a real RNG is ~1e-77.
    // If this ever flakes, assume the hardware RNG is stuck, not bad luck.
    expect(a).not.toBe(b);
  });
});
