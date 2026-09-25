/**
 * Memory Master Key (MMK) hierarchy — the 14B1 change from 14B0.
 *
 * SPIKE ONLY. Instead of a Recovery Key protecting every backup directly (14B0),
 * a persistent MMK sits in the middle:
 *
 *   Recovery Method → wraps → MMK → wraps → per-backup DEK → encrypts → bundle
 *
 * Consequences this enables (validated by tests in mmk.test.ts / modes.test.ts):
 *  - Add a recovery method by adding ONE MMK wrapper — no re-encryption of any
 *    backup bundle.
 *  - Multiple recovery methods (passkeys, a recovery file) each wrap the SAME MMK,
 *    independently; removing one leaves the others working.
 *  - Rotate a recovery method by re-wrapping the MMK, again without touching
 *    bundle ciphertext.
 *  - Each backup still gets a fresh random DEK (nonce-reuse impossible).
 *
 * The MMK, DEKs, and any KEK are never persisted in the clear and never leave the
 * device.
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
  mmkId: string; // opaque id, not the MMK
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

/** Canonical AAD binding a wrapper to its MMK and method (prevents transplanting). */
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

/**
 * Add a wrapper: encrypt the MMK under a method-derived KEK. `salt` is the public
 * per-wrapper HKDF salt (stored in the wrapper); `info` is the domain label used
 * to derive `kek`. Returns the new wrapper and the keyring with it appended.
 */
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

/** Wrapped-DEK record stored alongside a Protected backup. */
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
