/**
 * Key derivation for Phase 14B1.
 *
 * SPIKE ONLY. Two DISTINCT derivation paths that must never be mixed:
 *
 *  1. HIGH-ENTROPY random material (a 256-bit random Recovery Key, or a 32-byte
 *     WebAuthn PRF output). This is already cryptographically random, so a
 *     password-hardening (memory-hard) KDF buys nothing. The correct primitive is
 *     **HKDF-SHA-256** with explicit domain separation — cheap, standard
 *     (RFC 5869), and available identically in Node and Web Crypto. That is what
 *     this module provides.
 *
 *  2. HUMAN-CHOSEN passwords/passphrases (low entropy). Those would need a
 *     memory-hard password KDF (scrypt/Argon2id). Phase 14B1 introduces NO such
 *     path; if one is added later it lives in a separate module and is never
 *     conflated with the HKDF path here.
 *
 * Domain-separation labels are versioned so the derivation can evolve without
 * silently colliding with old material.
 */
import { hkdfSync } from 'node:crypto';

import { KEY_BYTES } from './cipher.js';

/** Versioned HKDF `info` labels — one per purpose, never reused across purposes. */
export const KDF_LABELS = {
  recoveryKey: 'stack-memory-recovery-v1',
  passkeyPrf: 'stack-memory-passkey-v1',
  bridge: 'stack-memory-bridge-v1',
} as const;

/**
 * HKDF-SHA-256 → a 32-byte key. `salt` binds the derivation to a per-artifact
 * random value; `info` is the versioned domain-separation label (+ optional
 * context). Inputs must already be high-entropy — see the module note.
 */
export const hkdf32 = (options: {
  ikm: Uint8Array; // high-entropy input keying material
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
