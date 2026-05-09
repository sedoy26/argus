import { beforeAll, describe, expect, test } from 'bun:test';
import { callApplet, preflight, setupApplet } from '../../scripts/test-helpers';

describe('Square applet', () => {
  beforeAll(async () => {
    await preflight();
    await setupApplet('square');
  }, 120_000);

  test('7 squared is 49', async () => {
    expect(await callApplet('Square', '7')).toBe('49');
  });

  test('0 squared is 0', async () => {
    expect(await callApplet('Square', '0')).toBe('0');
  });

  test('-3 squared is 9', async () => {
    expect(await callApplet('Square', '-3')).toBe('9');
  });

  test('saturates at i64::MAX instead of overflowing', async () => {
    // i64::MAX = 9223372036854775807. Its square overflows, so the Rust
    // applet uses saturating_mul → output stays at i64::MAX.
    expect(await callApplet('Square', '9223372036854775807')).toBe(
      '9223372036854775807',
    );
  });
});
