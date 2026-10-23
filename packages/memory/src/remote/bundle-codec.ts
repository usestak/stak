/**
 * MemoryBackupCodec — canonical, byte-exact bundling of the Phase 14A store.
 *
 * The bundle is the unit that is encrypted (Protected) or stored as-is (Standard).
 * It reconstructs the Phase 14A private store WITHOUT changing its local format:
 * the manifest file and every referenced content-addressed object are preserved
 * byte-for-byte. Native Memory is NOT turned into semantic facts, Markdown is not
 * modified, line endings are not normalized. Hash verification is mandatory.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { MemoryManifest } from '../domain.js';
import {
  hashBytes,
  memoryStorePaths,
  readMemoryManifest,
  readMemoryObject,
  writeMemoryObject,
} from '../store.js';
import { canonicalMainManifestSchema, type CanonicalMainManifest } from '../canonical/domain.js';
import { canonicalStorePaths } from '../canonical/store.js';
import { atomicWriteFile } from './secure-file.js';

export const BUNDLE_FORMAT = 'stack-mem-bundle-v1' as const;
export const BUNDLE_FORMAT_V2 = 'stack-mem-bundle-v2' as const;

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
  bundleFormat: z.union([z.literal(BUNDLE_FORMAT), z.literal(BUNDLE_FORMAT_V2)]),
  provider: z.literal('claude'),
  manifestSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  manifestB64: z.string(),
  objects: z.array(bundleObjectSchema),
  // Phase 15B: OPTIONAL portable project-registry snapshot. Backward-compatible —
  // historical bundles (generation 3 and earlier) omit it and still decode. When
  // present it is byte-verified and rebuilt into the store on restore. The bundle
  // is the unit that is encrypted (Protected) or stored (Standard), so this rides
  // in the same privacy mode as the rest of the bundle; the server never inspects it.
  registrySha256: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  registryB64: z.string().optional(),
  // v2 only: the canonical Project Memory manifest, byte-exact.
  canonicalSha256: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  canonicalB64: z.string().optional(),
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
    // Registry fields appear only when present, keeping historical bundles byte-stable.
    ...(bundle.registrySha256 && bundle.registryB64
      ? {
          registrySha256: bundle.registrySha256,
          registryB64: bundle.registryB64,
        }
      : {}),
    ...(bundle.canonicalSha256 && bundle.canonicalB64
      ? {
          canonicalSha256: bundle.canonicalSha256,
          canonicalB64: bundle.canonicalB64,
        }
      : {}),
  };
  return Buffer.from(JSON.stringify(canonical), 'utf8');
};

/**
 * Every content hash this bundle must carry an object for: the v1 manifest's own
 * items, PLUS (v2 only) every `present` canonical document's `contentHash`. Task
 * 13 found this the hard way: once `stak memory backup`/`stak push` migrate the
 * local store before bundling, project-scope content moves OUT of the v1
 * manifest (see `migrate.ts`'s `slimToGlobal`) and lives only as canonical
 * documents — a bundle that scanned only `manifest.items` would silently stop
 * carrying those objects at all, so a recovering machine would restore a
 * `canonical/main.json` whose documents point at content that was never
 * uploaded. Deleted canonical documents (`state: 'deleted'`) reference no live
 * content and are correctly excluded.
 */
const referencedHashes = (
  manifest: MemoryManifest,
  canonicalMain?: CanonicalMainManifest,
): string[] => {
  const hashes = new Set(manifest.items.map((item) => item.contentHash));
  if (canonicalMain)
    for (const project of canonicalMain.projects)
      for (const doc of project.documents)
        if (doc.state === 'present') hashes.add(doc.contentHash);
  return [...hashes];
};

/** Read the current Phase 14A store into a canonical bundle (parsed + bytes). */
export const bundleFromStore = async (
  stackHome: string,
): Promise<{ bundle: MemoryBackupBundle; bytes: Buffer }> => {
  const manifest = await readMemoryManifest(stackHome);
  if (!manifest)
    throw new BundleError('no-backup', 'No Memory backup exists to bundle.');
  const manifestBytes = await readFile(
    memoryStorePaths(stackHome).currentManifest,
  );
  // Read `canonical/main.json` directly (not through `readCanonicalMain`'s
  // empty-default fallback) so a never-migrated store still produces a
  // byte-identical v1 bundle — only a store that genuinely HAS a canonical
  // manifest on disk upgrades to v2.
  const canonicalBytes = await readFile(canonicalStorePaths(stackHome).main).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  const canonicalMain = canonicalBytes
    ? canonicalMainManifestSchema.parse(JSON.parse(canonicalBytes.toString('utf8')))
    : undefined;
  const objects = [];
  for (const contentHash of referencedHashes(manifest, canonicalMain)) {
    const bytes = await readMemoryObject({ stackHome, contentHash });
    objects.push({
      contentHash,
      bytesB64: Buffer.from(bytes).toString('base64'),
    });
  }
  // Include the portable project-registry snapshot when the store has one.
  const registryBytes = await readFile(
    memoryStorePaths(stackHome).projectRegistrySnapshot,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const bundle: MemoryBackupBundle = {
    bundleFormat: canonicalBytes ? BUNDLE_FORMAT_V2 : BUNDLE_FORMAT,
    provider: 'claude',
    manifestSha256: hashBytes(manifestBytes),
    manifestB64: manifestBytes.toString('base64'),
    objects,
    ...(registryBytes
      ? {
          registrySha256: hashBytes(registryBytes),
          registryB64: registryBytes.toString('base64'),
        }
      : {}),
    ...(canonicalBytes
      ? {
          canonicalSha256: hashBytes(canonicalBytes),
          canonicalB64: canonicalBytes.toString('base64'),
        }
      : {}),
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

/**
 * Rebuild the Phase 14A store from bundle bytes into `stackHome`. Objects go
 * through the real content-addressed store (which re-verifies each hash); the
 * manifest is restored byte-for-byte and re-verified. Idempotent.
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
  await atomicWriteFile(manifestPath, manifestBytes);
  const roundTrip = await readFile(manifestPath);
  if (hashBytes(roundTrip) !== bundle.manifestSha256)
    throw new BundleError(
      'restore-verify',
      'Restored manifest failed byte-exact verification.',
    );
  // Rebuild the portable project-registry snapshot when the bundle carried one.
  if (bundle.registryB64 && bundle.registrySha256) {
    const registryBytes = Buffer.from(bundle.registryB64, 'base64');
    if (hashBytes(registryBytes) !== bundle.registrySha256)
      throw new BundleError(
        'manifest-hash-mismatch',
        'The bundled project registry does not match its hash.',
      );
    await atomicWriteFile(
      memoryStorePaths(options.stackHome).projectRegistrySnapshot,
      registryBytes,
    );
  }
  // Rebuild the canonical Memory manifest when the bundle carried one (v2).
  if (bundle.canonicalB64 && bundle.canonicalSha256) {
    const canonicalBytes = Buffer.from(bundle.canonicalB64, 'base64');
    if (hashBytes(canonicalBytes) !== bundle.canonicalSha256)
      throw new BundleError(
        'manifest-hash-mismatch',
        'The bundled canonical Memory manifest does not match its hash.',
      );
    await atomicWriteFile(canonicalStorePaths(options.stackHome).main, canonicalBytes);
  }
  return {
    objects: bundle.objects.length,
    manifestSha256: bundle.manifestSha256,
  };
};

/** Staging path used for atomic recovery (the codec writes to the real store). */
export const stagingId = (): string => randomUUID();
