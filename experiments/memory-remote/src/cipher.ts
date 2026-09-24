/**
 * MemoryCipher — authenticated encryption for the Memory backup spike.
 *
 * SPIKE ONLY. Not wired into any shipping code path. Uses Node's built-in
 * primitives; no custom cryptography is invented here.
 *
 * Choice: AES-256-GCM.
 *  - AEAD (confidentiality + integrity) in one primitive, FIPS-approved, and
 *    hardware-accelerated (AES-NI) on the laptops Stack targets.
 *  - 96-bit random nonce per message (never reused with a given key). Every
 *    backup gets a fresh random DEK, so the nonce-reuse ceiling (~2^32 msgs per
 *    key) is never approached: one key encrypts exactly one bundle.
 *  - Considered XChaCha20-Poly1305 (larger 192-bit nonce → random-nonce-safe at
 *    scale). Rejected for V0 only because it is not in Node core without a native
 *    addon; the envelope is versioned (see `cryptoVersion`) so a future backend
 *    can add it without breaking old backups. AES-256-GCM is the documented V0.
 *
 * The 16-byte GCM tag authenticates BOTH the ciphertext and the associated data
 * (AAD). Callers pass the canonical envelope header as AAD, so any tamper with
 * the routing metadata (backup id, generation, bundle hash, timestamps) makes
 * decryption fail closed rather than silently returning attacker-chosen framing.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Version tag baked into every envelope header; bump on any format change. */
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

/** Opaque ciphertext, as it travels to and lives on the remote backend. */
export type SealedBytes = {
  nonce: Buffer; // 12 bytes, random per message
  ciphertext: Buffer;
  tag: Buffer; // 16-byte GCM authentication tag
};

const assertKey = (key: Buffer): void => {
  if (key.length !== KEY_BYTES)
    throw new CipherError(
      'bad-key-length',
      `Expected a ${KEY_BYTES}-byte key, received ${key.length}.`,
    );
};

/** Generate a fresh random symmetric key (a per-backup DEK, or a KEK). */
export const randomKey = (): Buffer => randomBytes(KEY_BYTES);

/**
 * AEAD-encrypt `plaintext` under `key`, authenticating `aad`. Returns a fresh
 * random nonce with the ciphertext and tag. `aad` is authenticated but NOT
 * encrypted — pass only non-sensitive framing there.
 */
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
 * ciphertext or tag has been modified or truncated, or the `aad` does not match
 * the value used at seal time. Never returns unauthenticated plaintext.
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
