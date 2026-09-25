/**
 * Key derivation for remote Memory (production).
 *
 * HIGH-ENTROPY inputs only (a 256-bit random Recovery Key, or a 32-byte WebAuthn
 * PRF output). These are already random, so a password-hardening (memory-hard) KDF
 * buys nothing; the correct primitive is HKDF-SHA-256 (RFC 5869) with explicit
 * versioned domain separation, available identically in Node and Web Crypto.
 *
 * A human-chosen passphrase (low entropy) would need a memory-hard password KDF
 * and belongs in a separate module — never mixed with this path.
 */
import { hkdfSync } from 'node:crypto';

import { KEY_BYTES } from './cipher.js';

/** Versioned HKDF `info` labels — one per purpose, never reused across purposes. */
export const KDF_LABELS = {
  recoveryKey: 'stack-memory-recovery-v1',
  passkeyPrf: 'stack-memory-passkey-v1',
  bridge: 'stack-memory-bridge-v1',
} as const;

/** HKDF-SHA-256 → a 32-byte key. Inputs must already be high-entropy. */
export const hkdf32 = (options: {
  ikm: Uint8Array;
  salt: Uint8Array;
  info: string;
}): Buffer =>
  Buffer.from(
    hkdfSync(
      'sha256',
      options.ikm,
      options.salt,
      Buffer.from(options.info, 'utf8'),
      KEY_BYTES,
    ),
  );

/** Derive the Recovery-Key KEK from a high-entropy random recovery key. */
export const deriveRecoveryKek = (
  recoveryKeyBytes: Uint8Array,
  salt: Uint8Array,
): Buffer =>
  hkdf32({ ikm: recoveryKeyBytes, salt, info: KDF_LABELS.recoveryKey });

/** Derive the Passkey KEK from a WebAuthn PRF output (typically 32 bytes). */
export const derivePasskeyKek = (
  prfOutput: Uint8Array,
  salt: Uint8Array,
): Buffer => hkdf32({ ikm: prfOutput, salt, info: KDF_LABELS.passkeyPrf });
