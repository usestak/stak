/**
 * LocalMemoryKeyStore — device-local persistence of the MMK (production V0).
 *
 * A device that has enrolled in Protected mode holds the MMK locally so everyday
 * `stack memory backup` never triggers a passkey ceremony. This is an abstraction:
 * callers use `saveMmk`/`loadMmk`/`clear` and never learn how the MMK is stored, so
 * a future version can swap in OS-native secure storage (Windows Credential
 * Manager / DPAPI, macOS Keychain, Linux Secret Service) without changing callers.
 *
 * V0 implementation: the MMK is stored as an AEAD envelope under a locally
 * generated device key, both written with owner-only (0600) permissions under
 * `$STACK_HOME/memory/keys/`. Honest security boundary:
 *   - It PRESERVES Stack Cloud server-blindness: the MMK never leaves the device.
 *   - It does NOT claim protection against full compromise of the local OS account
 *     (an attacker with the user's OS session can read both files). OS-native
 *     secure storage is documented future hardening.
 *   - The raw MMK is never written in plaintext, never placed in config files, and
 *     never logged.
 * The device-key indirection exists so the envelope format stays stable when the
 * device key later moves into OS-native storage.
 */
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { memoryStorePaths } from '../store.js';
import { KEY_BYTES, open, randomKey, seal } from './cipher.js';
import { atomicWriteFile } from './secure-file.js';

const DEVICE_MMK_VERSION = 'stack-mem-device-mmk-v1' as const;
const DEVICE_MMK_AAD = Buffer.from(DEVICE_MMK_VERSION, 'utf8');

export class LocalKeyStoreError extends Error {
  constructor(
    public readonly code: 'corrupt' | 'bad-device-key',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LocalKeyStoreError';
  }
}

const envelopeSchema = z.object({
  version: z.literal(DEVICE_MMK_VERSION),
  nonceB64: z.string(),
  ciphertextB64: z.string(),
  tagB64: z.string(),
});

export interface LocalMemoryKeyStore {
  hasKey(): Promise<boolean>;
  loadMmk(): Promise<Buffer | null>;
  saveMmk(mmk: Buffer): Promise<void>;
  clear(): Promise<void>;
}

const keyPaths = (stackHome: string) => {
  const keysDir = path.join(memoryStorePaths(stackHome).root, 'keys');
  return {
    keysDir,
    deviceKey: path.join(keysDir, 'device-key.bin'),
    envelope: path.join(keysDir, 'device-mmk.json'),
  };
};

const readIfExists = async (file: string): Promise<Buffer | null> => {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

/** File-based device MMK store (0600). See module header for the boundary. */
export const fileLocalMemoryKeyStore = (
  stackHome: string,
): LocalMemoryKeyStore => {
  const paths = keyPaths(stackHome);

  const loadDeviceKey = async (): Promise<Buffer | null> => {
    const bytes = await readIfExists(paths.deviceKey);
    if (!bytes) return null;
    if (bytes.length !== KEY_BYTES)
      throw new LocalKeyStoreError(
        'bad-device-key',
        'Local device key is malformed.',
      );
    return bytes;
  };

  return {
    async hasKey(): Promise<boolean> {
      const [key, envelope] = await Promise.all([
        readIfExists(paths.deviceKey),
        readIfExists(paths.envelope),
      ]);
      return key !== null && envelope !== null;
    },

    async loadMmk(): Promise<Buffer | null> {
      const deviceKey = await loadDeviceKey();
      const raw = await readIfExists(paths.envelope);
      if (!deviceKey || !raw) return null;
      let parsed;
      try {
        parsed = envelopeSchema.parse(JSON.parse(raw.toString('utf8')));
      } catch (error) {
        throw new LocalKeyStoreError(
          'corrupt',
          'Local MMK envelope is malformed.',
          { cause: error },
        );
      }
      try {
        return open(
          {
            nonce: Buffer.from(parsed.nonceB64, 'base64'),
            ciphertext: Buffer.from(parsed.ciphertextB64, 'base64'),
            tag: Buffer.from(parsed.tagB64, 'base64'),
          },
          deviceKey,
          DEVICE_MMK_AAD,
        );
      } catch (error) {
        throw new LocalKeyStoreError(
          'corrupt',
          'Local MMK envelope failed authentication (corrupt or wrong device key).',
          { cause: error },
        );
      }
    },

    async saveMmk(mmk: Buffer): Promise<void> {
      const deviceKey = (await loadDeviceKey()) ?? randomKey();
      await atomicWriteFile(paths.deviceKey, deviceKey, { mode: 0o600 });
      const sealed = seal(mmk, deviceKey, DEVICE_MMK_AAD);
      const envelope = {
        version: DEVICE_MMK_VERSION,
        nonceB64: sealed.nonce.toString('base64'),
        ciphertextB64: sealed.ciphertext.toString('base64'),
        tagB64: sealed.tag.toString('base64'),
      };
      await atomicWriteFile(
        paths.envelope,
        Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8'),
        { mode: 0o600 },
      );
    },

    async clear(): Promise<void> {
      await rm(paths.deviceKey, { force: true });
      await rm(paths.envelope, { force: true });
    },
  };
};
