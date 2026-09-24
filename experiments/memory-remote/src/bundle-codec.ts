/**
 * MemoryBackupCodec — canonical, byte-exact bundling of a Phase 14A Memory store.
 *
 * SPIKE ONLY. Reads and writes the REAL Phase 14A store via @stack/memory, so a
 * round-trip proves the codec reconstructs that store without changing its local
 * format. The codec is transport- and crypto-agnostic: it produces opaque bytes
 * that a MemoryCipher encrypts and a RemoteMemoryBackend stores. Encryption
 * happens AFTER bundling and decryption BEFORE un-bundling — the codec never
 * sees keys.
 *
 * A bundle preserves, byte-for-byte:
 *  - the manifest file (manifests/current.json) exactly as written on disk, and
 *  - every content-addressed object the manifest references.
 * That is sufficient to rebuild objects/** and manifests/current.json identically
 * on a new machine; Phase 14A restore then rebinds them to local projects.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  hashBytes,
  memoryStorePaths,
  readMemoryManifest,
  readMemoryObject,
  writeMemoryObject,
  type MemoryManifest,
} from '@stack/memory';
import { z } from 'zod';

export const BUNDLE_FORMAT = 'stack-mem-bundle-v1' as const;

export class BundleError extends Error {
  constructor(
    public readonly code:
      | 'no-backup'
      | 'bundle-parse'
      | 'object-hash-mismatch'
      | 'manifest-hash-mismatch'
      | 'restore-verify',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BundleError';
  }
}

const bundleObjectSchema = z.object({
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  bytesB64: z.string(),
});

const bundleSchema = z.object({
  bundleFormat: z.literal(BUNDLE_FORMAT),
  provider: z.literal('claude'),
  manifestSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  manifestB64: z.string(),
  objects: z.array(bundleObjectSchema),
});

export type MemoryBackupBundle = z.infer<typeof bundleSchema>;

/** Deterministic serialization: fixed key order, objects sorted by content hash. */
const serialize = (bundle: MemoryBackupBundle): Buffer => {
  const canonical = {
    bundleFormat: bundle.bundleFormat,
    provider: bundle.provider,
    manifestSha256: bundle.manifestSha256,
    manifestB64: bundle.manifestB64,
    objects: [...bundle.objects]
      .sort((a, b) => (a.contentHash < b.contentHash ? -1 : 1))
      .map((object) => ({
        contentHash: object.contentHash,
        bytesB64: object.bytesB64,
      })),
  };
  return Buffer.from(JSON.stringify(canonical), 'utf8');
};

/** Distinct content hashes referenced by a manifest, in stable order. */
const referencedHashes = (manifest: MemoryManifest): string[] => [
  ...new Set(manifest.items.map((item) => item.contentHash)),
];

/**
 * Read the current Phase 14A store into a canonical bundle. Returns both the
 * parsed bundle and its serialized bytes (what gets encrypted). Throws
 * `BundleError('no-backup')` when the store has no manifest.
 */
export const bundleFromStore = async (
  stackHome: string,
): Promise<{ bundle: MemoryBackupBundle; bytes: Buffer }> => {
  const manifest = await readMemoryManifest(stackHome);
  if (!manifest)
    throw new BundleError('no-backup', 'No Memory backup exists to bundle.');
  const manifestBytes = await readFile(
    memoryStorePaths(stackHome).currentManifest,
  );
  const objects = [];
  for (const contentHash of referencedHashes(manifest)) {
    const bytes = await readMemoryObject({ stackHome, contentHash });
    objects.push({
      contentHash,
      bytesB64: Buffer.from(bytes).toString('base64'),
    });
  }
  const bundle: MemoryBackupBundle = {
    bundleFormat: BUNDLE_FORMAT,
    provider: 'claude',
    manifestSha256: hashBytes(manifestBytes),
    manifestB64: manifestBytes.toString('base64'),
    objects,
  };
  return { bundle, bytes: serialize(bundle) };
};

/** Parse + validate serialized bundle bytes. */
export const parseBundle = (bytes: Uint8Array): MemoryBackupBundle => {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new BundleError('bundle-parse', 'Bundle is not valid JSON.', {
      cause: error,
    });
  }
  const parsed = bundleSchema.safeParse(json);
  if (!parsed.success)
    throw new BundleError('bundle-parse', 'Bundle failed schema validation.', {
      cause: parsed.error,
    });
  return parsed.data;
};

const atomicWrite = async (
  target: string,
  bytes: Uint8Array,
): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

/**
 * Rebuild the Phase 14A store from bundle bytes into `stackHome`. Objects are
 * written through the real content-addressed store (which re-verifies each hash);
 * the manifest is restored byte-for-byte. Verifies every object hash and the
 * manifest hash before returning. Idempotent per the store's write semantics.
 */
export const restoreBundleToStore = async (options: {
  bytes: Uint8Array;
  stackHome: string;
}): Promise<{ objects: number; manifestSha256: string }> => {
  const bundle = parseBundle(options.bytes);
  for (const object of bundle.objects) {
    const bytes = Buffer.from(object.bytesB64, 'base64');
    if (hashBytes(bytes) !== object.contentHash)
      throw new BundleError(
        'object-hash-mismatch',
        'A bundled object does not match its content hash.',
      );
    await writeMemoryObject({
      stackHome: options.stackHome,
      contentHash: object.contentHash,
      bytes,
    });
  }
  const manifestBytes = Buffer.from(bundle.manifestB64, 'base64');
  if (hashBytes(manifestBytes) !== bundle.manifestSha256)
    throw new BundleError(
      'manifest-hash-mismatch',
      'The bundled manifest does not match its hash.',
    );
  const manifestPath = memoryStorePaths(options.stackHome).currentManifest;
  await atomicWrite(manifestPath, manifestBytes);
  // Verify the store reads back the manifest we just wrote.
  const roundTrip = await readFile(manifestPath);
  if (hashBytes(roundTrip) !== bundle.manifestSha256)
    throw new BundleError(
      'restore-verify',
      'Restored manifest failed byte-exact verification.',
    );
  return {
    objects: bundle.objects.length,
    manifestSha256: bundle.manifestSha256,
  };
};
