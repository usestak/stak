/**
 * Memory Master Key (MMK) hierarchy (production).
 *
 *   recovery method → wraps → MMK → wraps → per-backup DEK → encrypts → bundle
 *
 * A persistent random 256-bit MMK sits between recovery methods and per-backup
 * DEKs. Multiple recovery methods each wrap the SAME MMK independently, so adding
 * or removing a method never re-encrypts any backup, and each backup still gets a
 * fresh random DEK. The MMK, DEKs, and KEKs are never persisted in the clear and
 * never leave the device except through the zero-knowledge bridge.
 */
import { randomUUID } from 'node:crypto';

import { open, randomKey, seal, type SealedBytes } from './cipher.js';

export type RecoveryMethodType = 'recovery-file' | 'passkey' | 'trusted-device';

/** A single recovery-method envelope over the MMK. */
export type MmkWrapper = {
  wrapperId: string;
  methodType: RecoveryMethodType;
  label: string;
  kdf: { name: 'hkdf-sha256'; saltB64: string; info: string };
  sealed: { nonceB64: string; ciphertextB64: string; tagB64: string };
};

/** The set of wrappers protecting one MMK. Holds NO key material itself. */
export type MmkKeyring = {
  mmkId: string;
  wrappers: MmkWrapper[];
};

export class MmkError extends Error {
  constructor(
    public readonly code:
      'wrapper-not-found' | 'unwrap-failed' | 'last-wrapper',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MmkError';
  }
}

/** Generate a fresh persistent MMK (32 random bytes). */
export const generateMmk = (): Buffer => randomKey();

export const newKeyring = (): MmkKeyring => ({
  mmkId: randomUUID(),
  wrappers: [],
});

const wrapperAad = (
  mmkId: string,
  wrapperId: string,
  methodType: RecoveryMethodType,
): Buffer =>
  Buffer.from(JSON.stringify({ mmkId, wrapperId, methodType }), 'utf8');

const toSealed = (wrapper: MmkWrapper): SealedBytes => ({
  nonce: Buffer.from(wrapper.sealed.nonceB64, 'base64'),
  ciphertext: Buffer.from(wrapper.sealed.ciphertextB64, 'base64'),
  tag: Buffer.from(wrapper.sealed.tagB64, 'base64'),
});

/** Add a wrapper: encrypt the MMK under a method-derived KEK. */
export const addWrapper = (options: {
  keyring: MmkKeyring;
  mmk: Buffer;
  kek: Buffer;
  methodType: RecoveryMethodType;
  label: string;
  salt: Uint8Array;
  info: string;
}): { keyring: MmkKeyring; wrapper: MmkWrapper } => {
  const wrapperId = randomUUID();
  const sealed = seal(
    options.mmk,
    options.kek,
    wrapperAad(options.keyring.mmkId, wrapperId, options.methodType),
  );
  const wrapper: MmkWrapper = {
    wrapperId,
    methodType: options.methodType,
    label: options.label,
    kdf: {
      name: 'hkdf-sha256',
      saltB64: Buffer.from(options.salt).toString('base64'),
      info: options.info,
    },
    sealed: {
      nonceB64: sealed.nonce.toString('base64'),
      ciphertextB64: sealed.ciphertext.toString('base64'),
      tagB64: sealed.tag.toString('base64'),
    },
  };
  return {
    keyring: {
      ...options.keyring,
      wrappers: [...options.keyring.wrappers, wrapper],
    },
    wrapper,
  };
};

/** Unwrap the MMK from a specific wrapper using the method-derived KEK. */
export const unwrapWith = (options: {
  keyring: MmkKeyring;
  wrapper: MmkWrapper;
  kek: Buffer;
}): Buffer => {
  try {
    return open(
      toSealed(options.wrapper),
      options.kek,
      wrapperAad(
        options.keyring.mmkId,
        options.wrapper.wrapperId,
        options.wrapper.methodType,
      ),
    );
  } catch (error) {
    throw new MmkError(
      'unwrap-failed',
      'Could not unwrap the MMK (wrong recovery material or tampered wrapper).',
      { cause: error },
    );
  }
};

/** Remove a wrapper (revoke a recovery method). Refuses to remove the last one. */
export const removeWrapper = (
  keyring: MmkKeyring,
  wrapperId: string,
): MmkKeyring => {
  const remaining = keyring.wrappers.filter(
    (wrapper) => wrapper.wrapperId !== wrapperId,
  );
  if (remaining.length === keyring.wrappers.length)
    throw new MmkError(
      'wrapper-not-found',
      'No such recovery method to remove.',
    );
  if (remaining.length === 0)
    throw new MmkError(
      'last-wrapper',
      'Refusing to remove the only recovery method; Memory would become unrecoverable.',
    );
  return { ...keyring, wrappers: remaining };
};

export const findWrapper = (
  keyring: MmkKeyring,
  wrapperId: string,
): MmkWrapper => {
  const wrapper = keyring.wrappers.find(
    (candidate) => candidate.wrapperId === wrapperId,
  );
  if (!wrapper)
    throw new MmkError('wrapper-not-found', 'No such recovery method.');
  return wrapper;
};

// --- per-backup DEK, wrapped by the MMK -----------------------------------

export type WrappedDek = {
  nonceB64: string;
  ciphertextB64: string;
  tagB64: string;
};

const dekAad = (backupId: string): Buffer =>
  Buffer.from(JSON.stringify({ purpose: 'wrap-dek', backupId }), 'utf8');

/** Wrap a per-backup DEK under the MMK, bound to the backup id. */
export const wrapDekWithMmk = (
  dek: Buffer,
  mmk: Buffer,
  backupId: string,
): WrappedDek => {
  const sealed = seal(dek, mmk, dekAad(backupId));
  return {
    nonceB64: sealed.nonce.toString('base64'),
    ciphertextB64: sealed.ciphertext.toString('base64'),
    tagB64: sealed.tag.toString('base64'),
  };
};

/** Unwrap a per-backup DEK using the MMK. Throws on wrong MMK or tamper. */
export const unwrapDekWithMmk = (
  wrapped: WrappedDek,
  mmk: Buffer,
  backupId: string,
): Buffer => {
  try {
    return open(
      {
        nonce: Buffer.from(wrapped.nonceB64, 'base64'),
        ciphertext: Buffer.from(wrapped.ciphertextB64, 'base64'),
        tag: Buffer.from(wrapped.tagB64, 'base64'),
      },
      mmk,
      dekAad(backupId),
    );
  } catch (error) {
    throw new MmkError('unwrap-failed', 'Could not unwrap the backup DEK.', {
      cause: error,
    });
  }
};
