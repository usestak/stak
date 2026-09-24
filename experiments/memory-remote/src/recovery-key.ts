/**
 * RecoveryKeyProvider — the zero-knowledge-compatible recovery mechanism for the
 * Option A spike.
 *
 * SPIKE ONLY. The model:
 *  - A high-entropy Stack Recovery Key is generated CLIENT-SIDE (256 bits from a
 *    CSPRNG), shown to the user exactly once, and never sent to any server in
 *    plaintext. It is the user's sole route back to their Memory after total
 *    device loss.
 *  - From the recovery key we derive a Key-Encryption-Key (KEK) with scrypt
 *    (memory-hard KDF) using a per-backup random salt.
 *  - The KEK wraps (AEAD-encrypts) the per-backup Data-Encryption-Key (DEK).
 *  - Only the wrapped DEK record leaves the device. The server stores the
 *    wrapped DEK but never the recovery key, the KEK, or the DEK — so the
 *    provider cannot decrypt a backup with account access alone.
 *
 * Why scrypt: it is in Node core, memory-hard (resists GPU/ASIC brute force),
 * and standardized. Argon2id would be a defensible alternative but needs a
 * native addon; the wrapped-key record is versioned (`WRAP_SCHEME`) so a future
 * backend can migrate. Because the recovery key itself carries 256 bits of
 * entropy, the KDF's job here is defense-in-depth against a weak-RNG surprise,
 * not to stretch a low-entropy human password.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

import { KEY_BYTES, open, seal, type SealedBytes } from './cipher.js';

export const WRAP_SCHEME = 'recovery-key-scrypt-aesgcm-v1' as const;

/** scrypt cost parameters (V0). N=2^15 → ~32 MiB working set per derivation. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;

/** Crockford base32 alphabet (no I, L, O, U — unambiguous when read aloud). */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_ENTROPY_BYTES = 32; // 256 bits

/** The wrapped DEK record — the only key material that leaves the device. */
export type WrappedKeyRecord = {
  scheme: typeof WRAP_SCHEME;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; keyLen: number };
  saltB64: string;
  nonceB64: string;
  ciphertextB64: string;
  tagB64: string;
};

const scryptAsync = (
  passphrase: Buffer,
  salt: Buffer,
  keyLen: number,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCb(
      passphrase,
      salt,
      keyLen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });

/** Encode raw bytes as grouped Crockford base32 (display form of the key). */
const toBase32Groups = (bytes: Buffer): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const index = (value >>> bits) & 0x1f;
      out += BASE32[index] ?? '0';
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 0x1f] ?? '0';
  // Group into blocks of 5 for legibility: XXXXX-XXXXX-...
  return (out.match(/.{1,5}/g) ?? [out]).join('-');
};

/**
 * Normalize a recovery key the user typed back in: strip separators and spaces,
 * uppercase. The normalized ASCII bytes are the scrypt passphrase, so display
 * grouping never affects derivation.
 */
export const normalizeRecoveryKey = (recoveryKey: string): string =>
  recoveryKey.replace(/[\s-]+/g, '').toUpperCase();

/** Generate a new 256-bit Stack Recovery Key in display form. */
export const generateRecoveryKey = (): string =>
  toBase32Groups(randomBytes(RECOVERY_ENTROPY_BYTES));

/** Derive the KEK from the recovery key and a per-backup salt. */
const deriveKek = async (recoveryKey: string, salt: Buffer): Promise<Buffer> =>
  scryptAsync(
    Buffer.from(normalizeRecoveryKey(recoveryKey), 'utf8'),
    salt,
    KEY_BYTES,
  );

/**
 * Wrap a per-backup DEK under a KEK derived from the recovery key. A fresh
 * random salt is generated per call, so the same recovery key produces
 * independent wrapped records for each backup. `aad` binds the wrapped record to
 * its backup (pass the backup id) so it cannot be transplanted onto another.
 */
export const wrapDek = async (options: {
  dek: Buffer;
  recoveryKey: string;
  aad: Uint8Array;
}): Promise<WrappedKeyRecord> => {
  const salt = randomBytes(16);
  const kek = await deriveKek(options.recoveryKey, salt);
  const sealed = seal(options.dek, kek, options.aad);
  return {
    scheme: WRAP_SCHEME,
    kdf: {
      name: 'scrypt',
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      keyLen: KEY_BYTES,
    },
    saltB64: salt.toString('base64'),
    nonceB64: sealed.nonce.toString('base64'),
    ciphertextB64: sealed.ciphertext.toString('base64'),
    tagB64: sealed.tag.toString('base64'),
  };
};

export class RecoveryError extends Error {
  constructor(
    public readonly code: 'unsupported-scheme' | 'unwrap-failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RecoveryError';
  }
}

/**
 * Unwrap the DEK using the recovery key. Throws `RecoveryError('unwrap-failed')`
 * on a wrong recovery key or a tampered record — the caller then cannot decrypt.
 */
export const unwrapDek = async (options: {
  record: WrappedKeyRecord;
  recoveryKey: string;
  aad: Uint8Array;
}): Promise<Buffer> => {
  if (options.record.scheme !== WRAP_SCHEME)
    throw new RecoveryError(
      'unsupported-scheme',
      `Unknown wrapped-key scheme: ${String(options.record.scheme)}.`,
    );
  const salt = Buffer.from(options.record.saltB64, 'base64');
  const kek = await deriveKek(options.recoveryKey, salt);
  const sealed: SealedBytes = {
    nonce: Buffer.from(options.record.nonceB64, 'base64'),
    ciphertext: Buffer.from(options.record.ciphertextB64, 'base64'),
    tag: Buffer.from(options.record.tagB64, 'base64'),
  };
  try {
    return open(sealed, kek, options.aad);
  } catch (error) {
    throw new RecoveryError(
      'unwrap-failed',
      'Could not unwrap the backup key (wrong recovery key or tampered record).',
      { cause: error },
    );
  }
};

/** Constant-time equality for comparing two keys in tests/harnesses. */
export const keysEqual = (a: Buffer, b: Buffer): boolean =>
  a.length === b.length && timingSafeEqual(a, b);
