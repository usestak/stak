/**
 * Recovery methods that wrap the MMK (production).
 *
 *  - RECOVERY FILE: a 256-bit client-generated random Recovery Key, exportable as
 *    a `.stackkey` file or a printable Crockford-base32 code, never stored plaintext
 *    in Stack Cloud. HKDF (not a password KDF — the key is already random) derives
 *    the KEK. Honest caveat in the file itself: possession of the file unlocks
 *    Protected Memory; it is a usability artifact, not "secure by itself".
 *  - PASSKEY: a WebAuthn PRF output (32 bytes) from the browser. HKDF derives the
 *    KEK. This module handles the crypto GIVEN a PRF output; obtaining the PRF
 *    output is the browser's job (see the web recovery ceremony + bridge).
 *
 * Each method adds an independent wrapper over the SAME MMK.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { KDF_LABELS, derivePasskeyKek, deriveRecoveryKek } from './kdf.js';
import {
  addWrapper,
  unwrapWith,
  type MmkKeyring,
  type MmkWrapper,
} from './mmk.js';

export const RECOVERY_KEY_BYTES = 32;
export const RECOVERY_FILE_FORMAT = 'stack-memory-recovery-file-v1' as const;

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
  keyBytes: Buffer;
  printableCode: string;
  file: RecoveryFile;
};

export type RecoveryFile = {
  format: typeof RECOVERY_FILE_FORMAT;
  recoveryId: string;
  createdAt: string;
  note: string;
  secretB64: string;
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

export const recoveryKeyFromFile = (file: RecoveryFile): Buffer =>
  Buffer.from(file.secretB64, 'base64');
export const recoveryKeyFromCode = (code: string): Buffer => decodeBase32(code);

/**
 * Read the recovery key back out of a `.stackkey` file's text (as written by
 * `stak memory protect`). Throws a plain, secret-free error for anything that
 * isn't a well-formed recovery file.
 */
export const parseRecoveryFile = (text: string): Buffer => {
  const invalid = () => new Error("That file isn't a STAK recovery file.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalid();
  const file = parsed as Partial<RecoveryFile>;
  if (
    file.format !== RECOVERY_FILE_FORMAT ||
    typeof file.secretB64 !== 'string'
  )
    throw invalid();
  const key = Buffer.from(file.secretB64, 'base64');
  if (key.length !== RECOVERY_KEY_BYTES) throw invalid();
  return key;
};

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
