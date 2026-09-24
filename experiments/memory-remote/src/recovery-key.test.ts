import { describe, expect, it } from 'vitest';

import { randomKey } from './cipher.js';
import {
  RecoveryError,
  generateRecoveryKey,
  keysEqual,
  normalizeRecoveryKey,
  unwrapDek,
  wrapDek,
} from './recovery-key.js';

const aad = Buffer.from(
  JSON.stringify({ purpose: 'wrap-dek', backupId: 'b1' }),
);

describe('RecoveryKeyProvider', () => {
  it('generates a high-entropy, grouped, unique recovery key', () => {
    const a = generateRecoveryKey();
    const b = generateRecoveryKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{1,5})+$/);
    // 256 bits base32 → ~52 symbols of entropy, well above any brute-force reach.
    expect(normalizeRecoveryKey(a).length).toBeGreaterThanOrEqual(51);
  });

  it('wraps and unwraps a DEK with the correct recovery key', async () => {
    const dek = randomKey();
    const recoveryKey = generateRecoveryKey();
    const record = await wrapDek({ dek, recoveryKey, aad });
    const unwrapped = await unwrapDek({ record, recoveryKey, aad });
    expect(keysEqual(unwrapped, dek)).toBe(true);
  });

  it('tolerates display grouping/spacing when the key is retyped', async () => {
    const dek = randomKey();
    const recoveryKey = generateRecoveryKey();
    const record = await wrapDek({ dek, recoveryKey, aad });
    const retyped = ` ${recoveryKey.toLowerCase().replace(/-/g, ' ')} `;
    const unwrapped = await unwrapDek({ record, recoveryKey: retyped, aad });
    expect(keysEqual(unwrapped, dek)).toBe(true);
  });

  it('fails to unwrap with a wrong recovery key', async () => {
    const record = await wrapDek({
      dek: randomKey(),
      recoveryKey: generateRecoveryKey(),
      aad,
    });
    await expect(
      unwrapDek({ record, recoveryKey: generateRecoveryKey(), aad }),
    ).rejects.toBeInstanceOf(RecoveryError);
  });

  it('fails to unwrap when the binding AAD differs (wrong backup)', async () => {
    const dek = randomKey();
    const recoveryKey = generateRecoveryKey();
    const record = await wrapDek({ dek, recoveryKey, aad });
    const otherAad = Buffer.from(
      JSON.stringify({ purpose: 'wrap-dek', backupId: 'b2' }),
    );
    await expect(
      unwrapDek({ record, recoveryKey, aad: otherAad }),
    ).rejects.toMatchObject({ code: 'unwrap-failed' });
  });

  it('produces independent salts per wrap', async () => {
    const dek = randomKey();
    const recoveryKey = generateRecoveryKey();
    const a = await wrapDek({ dek, recoveryKey, aad });
    const b = await wrapDek({ dek, recoveryKey, aad });
    expect(a.saltB64).not.toBe(b.saltB64);
    expect(a.ciphertextB64).not.toBe(b.ciphertextB64);
  });
});
