/**
 * MemoryCipher — authenticated encryption for remote Memory (production).
 *
 * AES-256-GCM (AEAD): confidentiality + integrity in one primitive, AES-NI
 * accelerated, FIPS-approved, in Node core. A fresh random 96-bit nonce per
 * message; because every backup uses a fresh random DEK, one key encrypts exactly
 * one message, so nonce reuse is impossible. The 16-byte tag authenticates the
 * ciphertext AND the associated data (AAD) — callers pass versioned routing
 * metadata as AAD so any tamper fails closed. No custom cryptography.
 *
 * The envelope is versioned (`CIPHER_VERSION`) so the algorithm can evolve without
 * breaking older backups.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const CIPHER_VERSION = 'stack-mem-cipher-v1' as const;

export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;
export const TAG_BYTES = 16;

export class CipherError extends Error {
  constructor(
    public readonly code: 'bad-key-length' | 'auth-failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CipherError';
  }
}

/** Opaque ciphertext as it travels to and lives on the remote backend. */
export type SealedBytes = {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
};

const assertKey = (key: Buffer): void => {
  if (key.length !== KEY_BYTES)
    throw new CipherError(
      'bad-key-length',
      `Expected a ${KEY_BYTES}-byte key, received ${key.length}.`,
    );
};

/** Generate a fresh random symmetric key (a per-backup DEK, an MMK, or a KEK). */
export const randomKey = (): Buffer => randomBytes(KEY_BYTES);

/** AEAD-encrypt `plaintext` under `key`, authenticating (not encrypting) `aad`. */
export const seal = (
  plaintext: Uint8Array,
  key: Buffer,
  aad: Uint8Array,
): SealedBytes => {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext, tag };
};

/**
 * AEAD-decrypt. Throws `CipherError('auth-failed')` when the key is wrong, the
 * ciphertext/tag was modified or truncated, or `aad` differs from seal time.
 */
export const open = (
  sealed: SealedBytes,
  key: Buffer,
  aad: Uint8Array,
): Buffer => {
  assertKey(key);
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.tag);
  try {
    return Buffer.concat([
      decipher.update(sealed.ciphertext),
      decipher.final(),
    ]);
  } catch (error) {
    throw new CipherError(
      'auth-failed',
      'Authenticated decryption failed (wrong key, or tampered/truncated data).',
      { cause: error },
    );
  }
};
