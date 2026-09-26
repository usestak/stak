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
 * generated device key, both under `$STACK_HOME/memory/keys/`. On POSIX they are
 * written owner-only (mode 0o600). On Windows, `mode` does NOT set NTFS ACLs, so we
 * restrict the keys directory to the current user's SID via the built-in `icacls`
 * (breaking inherited ACEs); Administrators/SYSTEM always retain access on Windows.
 *
 * FAIL-CLOSED: after writing, `saveMmk` verifies the result is owner-only (POSIX:
 * mode has no group/other bits; Windows: the dir DACL has a single non-inherited
 * principal). If verification fails, the partially-written key state is removed and
 * `saveMmk` throws — Stack never persists usable-but-insecure device key material,
 * so enrollment cannot silently succeed with weaker permissions than it claims.
 * Honest security boundary:
 *   - It PRESERVES Stack Cloud server-blindness: the MMK never leaves the device.
 *   - Anyone who can read BOTH files (the device key AND the envelope) can decrypt
 *     the MMK — the device-key indirection is for future OS-keystore migration, not
 *     added protection against local theft of both files.
 *   - It does NOT protect against full compromise of the local OS account (or a
 *     local Administrator). OS-native secure storage (DPAPI / Keychain / Secret
 *     Service) is documented future hardening.
 *   - The raw MMK is never written in plaintext, never placed in config files, and
 *     never logged.
 */
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { memoryStorePaths } from '../store.js';
import { KEY_BYTES, open, randomKey, seal } from './cipher.js';
import {
  atomicWriteFile,
  hardenOwnerOnly,
  secureMkdir,
  verifyOwnerOnly,
} from './secure-file.js';

const DEVICE_MMK_VERSION = 'stack-mem-device-mmk-v1' as const;
const DEVICE_MMK_AAD = Buffer.from(DEVICE_MMK_VERSION, 'utf8');

export class LocalKeyStoreError extends Error {
  constructor(
    public readonly code: 'corrupt' | 'bad-device-key' | 'insecure-permissions',
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

/**
 * Platform hooks, injected so the fail-closed permission logic is testable without
 * real OS ACLs. Defaults call the real (icacls / stat-based) implementations.
 */
export type LocalKeyStoreHooks = {
  harden?: (directory: string) => Promise<boolean>;
  verify?: (options: { keysDir: string; files: string[] }) => Promise<boolean>;
};

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
  hooks: LocalKeyStoreHooks = {},
): LocalMemoryKeyStore => {
  const paths = keyPaths(stackHome);
  const harden = hooks.harden ?? hardenOwnerOnly;
  const verify = hooks.verify ?? verifyOwnerOnly;

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
      // Lock the keys directory to the current user FIRST so files written into it
      // inherit an owner-only ACL (on Windows; a no-op on POSIX). Doing it before
      // the writes avoids leaving a file with an empty/ineffective DACL.
      await secureMkdir(paths.keysDir);
      await harden(paths.keysDir);
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
      // FAIL CLOSED: if we cannot verify owner-only permissions, remove the
      // partially-written key state and refuse — never persist usable but
      // insecurely-permissioned device key material.
      const secure = await verify({
        keysDir: paths.keysDir,
        files: [paths.deviceKey, paths.envelope],
      });
      if (!secure) {
        await rm(paths.deviceKey, { force: true }).catch(() => undefined);
        await rm(paths.envelope, { force: true }).catch(() => undefined);
        throw new LocalKeyStoreError(
          'insecure-permissions',
          `Could not secure local Memory key storage on this device. ` +
            `Protected Memory was not enabled. Check permissions for: ${paths.keysDir}`,
        );
      }
    },

    async clear(): Promise<void> {
      await rm(paths.deviceKey, { force: true });
      await rm(paths.envelope, { force: true });
    },
  };
};
