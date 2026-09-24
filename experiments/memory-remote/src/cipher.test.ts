import { describe, expect, it } from 'vitest';

import { CipherError, open, randomKey, seal } from './cipher.js';

const aad = Buffer.from('routing-metadata');
const plaintext = Buffer.from('the secret memory bundle');

describe('MemoryCipher (AES-256-GCM AEAD)', () => {
  it('round-trips plaintext with the right key and AAD', () => {
    const key = randomKey();
    const sealed = seal(plaintext, key, aad);
    expect(open(sealed, key, aad).equals(plaintext)).toBe(true);
  });

  it('uses a fresh random nonce per message', () => {
    const key = randomKey();
    const a = seal(plaintext, key, aad);
    const b = seal(plaintext, key, aad);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('fails to decrypt with the wrong key', () => {
    const sealed = seal(plaintext, randomKey(), aad);
    expect(() => open(sealed, randomKey(), aad)).toThrowError(CipherError);
  });

  it('fails when the ciphertext is modified', () => {
    const key = randomKey();
    const sealed = seal(plaintext, key, aad);
    const byte = sealed.ciphertext[0] ?? 0;
    sealed.ciphertext[0] = byte ^ 0xff;
    expect(() => open(sealed, key, aad)).toThrowError(/authenticated/i);
  });

  it('fails when the ciphertext is truncated', () => {
    const key = randomKey();
    const sealed = seal(plaintext, key, aad);
    const truncated = {
      ...sealed,
      ciphertext: sealed.ciphertext.subarray(0, 4),
    };
    expect(() => open(truncated, key, aad)).toThrowError(CipherError);
  });

  it('fails when the authenticated AAD does not match', () => {
    const key = randomKey();
    const sealed = seal(plaintext, key, aad);
    expect(() =>
      open(sealed, key, Buffer.from('different-metadata')),
    ).toThrowError(CipherError);
  });

  it('rejects a wrong-length key', () => {
    let error: unknown;
    try {
      seal(plaintext, Buffer.alloc(16), aad);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(CipherError);
    expect((error as CipherError).code).toBe('bad-key-length');
  });
});
