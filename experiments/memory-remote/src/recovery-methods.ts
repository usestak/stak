/**
 * Recovery methods that wrap the MMK (Phase 14B1).
 *
 * SPIKE ONLY. Two concrete methods share the same MMK-wrapper mechanism (mmk.ts):
 *
 *  - RECOVERY FILE: a high-entropy (256-bit) random Recovery Key, generated
 *    client-side, exportable as a `.stackkey` file or a printable code, never
 *    stored plaintext in Stack Cloud. HKDF (not a password KDF — the key is
 *    already random) derives the KEK. Honest caveat: putting the secret in a file
 *    shifts the problem to protecting that file; the file is a usability artifact
 *    (save in a password manager / external drive), NOT "secure by itself".
 *
 *  - PASSKEY: a WebAuthn PRF output (32 bytes) supplied by the browser bridge.
 *    HKDF derives the KEK. This module handles only the CRYPTO given a PRF output;
 *    obtaining the PRF output is the browser's job (see dogfood/ and bridge.ts).
 *
 * Each method adds its own independent wrapper over the SAME MMK. Adding/removing
 * a method never re-encrypts backups.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { deriveRecoveryKek, derivePasskeyKek, KDF_LABELS } from './kdf.js';
import {
  addWrapper,
  unwrapWith,
  type MmkKeyring,
  type MmkWrapper,
} from './mmk.js';

export const RECOVERY_KEY_BYTES = 32; // 256-bit
export const RECOVERY_FILE_FORMAT = 'stack-memory-recovery-file-v1' as const;

/** Crockford base32 (no I/L/O/U) for the printable recovery code. */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const encodeBase32 = (bytes: Buffer): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 0x1f] ?? '0';
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 0x1f] ?? '0';
  return (out.match(/.{1,5}/g) ?? [out]).join('-');
};

const decodeBase32 = (code: string): Buffer => {
  const clean = code.replace(/[\s-]+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
};

export type RecoveryKeyArtifacts = {
  keyBytes: Buffer; // the raw secret (never persisted in Cloud)
  printableCode: string; // grouped base32, for a printed/password-manager code
  file: RecoveryFile; // downloadable .stackkey representation
};

export type RecoveryFile = {
  format: typeof RECOVERY_FILE_FORMAT;
  recoveryId: string;
  createdAt: string;
  note: string;
  secretB64: string; // the recovery secret; protecting the file is the user's job
};

/** Generate a new high-entropy Recovery Key with its exportable forms. */
export const generateRecoveryKey = (
  now: () => Date = () => new Date(),
): RecoveryKeyArtifacts => {
  const keyBytes = randomBytes(RECOVERY_KEY_BYTES);
  return {
    keyBytes,
    printableCode: encodeBase32(keyBytes),
    file: {
      format: RECOVERY_FILE_FORMAT,
      recoveryId: randomUUID(),
      createdAt: now().toISOString(),
      note: 'Anyone with this file can recover your Protected Memory. Keep it in a password manager or secure storage. This file is not secure by itself.',
      secretB64: keyBytes.toString('base64'),
    },
  };
};

/** Recover the raw key bytes from either exported form. */
export const recoveryKeyFromFile = (file: RecoveryFile): Buffer =>
  Buffer.from(file.secretB64, 'base64');
export const recoveryKeyFromCode = (code: string): Buffer => decodeBase32(code);

// --- wrapping the MMK with each method ------------------------------------

/** Add a recovery-file/recovery-key wrapper over the MMK. */
export const addRecoveryFileWrapper = (options: {
  keyring: MmkKeyring;
  mmk: Buffer;
  recoveryKey: Buffer;
  label?: string;
}): { keyring: MmkKeyring; wrapper: MmkWrapper } => {
  const salt = randomBytes(16);
  const kek = deriveRecoveryKek(options.recoveryKey, salt);
  return addWrapper({
    keyring: options.keyring,
    mmk: options.mmk,
    kek,
    methodType: 'recovery-file',
    label: options.label ?? 'Recovery file',
    salt,
    info: KDF_LABELS.recoveryKey,
  });
};

/** Unwrap the MMK using a recovery-file/recovery-key wrapper. */
export const unwrapWithRecoveryKey = (options: {
  keyring: MmkKeyring;
  wrapper: MmkWrapper;
  recoveryKey: Buffer;
}): Buffer => {
  const salt = Buffer.from(options.wrapper.kdf.saltB64, 'base64');
  const kek = deriveRecoveryKek(options.recoveryKey, salt);
  return unwrapWith({
    keyring: options.keyring,
    wrapper: options.wrapper,
    kek,
  });
};

/** Add a passkey wrapper over the MMK, given a PRF output from the browser. */
export const addPasskeyWrapper = (options: {
  keyring: MmkKeyring;
  mmk: Buffer;
  prfOutput: Uint8Array;
  label?: string;
}): { keyring: MmkKeyring; wrapper: MmkWrapper } => {
  const salt = randomBytes(16);
  const kek = derivePasskeyKek(options.prfOutput, salt);
  return addWrapper({
    keyring: options.keyring,
    mmk: options.mmk,
    kek,
    methodType: 'passkey',
    label: options.label ?? 'Passkey',
    salt,
    info: KDF_LABELS.passkeyPrf,
  });
};

/** Unwrap the MMK using a passkey wrapper and a PRF output. */
export const unwrapWithPasskey = (options: {
  keyring: MmkKeyring;
  wrapper: MmkWrapper;
  prfOutput: Uint8Array;
}): Buffer => {
  const salt = Buffer.from(options.wrapper.kdf.saltB64, 'base64');
  const kek = derivePasskeyKek(options.prfOutput, salt);
  return unwrapWith({
    keyring: options.keyring,
    wrapper: options.wrapper,
    kek,
  });
};
