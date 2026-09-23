import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertPathWithin } from '@stack/shared';

import { memoryManifestSchema, type MemoryManifest } from './domain.js';

export class MemoryStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MemoryStoreError';
  }
}

/** Private Memory store paths, deliberately disjoint from the Skill `store/`. */
export const memoryStorePaths = (stackHome: string) => {
  const root = path.join(path.resolve(stackHome), 'memory');
  return {
    root,
    objects: path.join(root, 'objects'),
    manifests: path.join(root, 'manifests'),
    currentManifest: path.join(root, 'manifests', 'current.json'),
  };
};

/** sha256 of raw bytes as `sha256:<hex>`. */
export const hashBytes = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const objectPath = (stackHome: string, contentHash: string): string => {
  const match = /^sha256:([a-f0-9]{64})$/.exec(contentHash);
  if (!match?.[1])
    throw new MemoryStoreError('invalid-hash', `Invalid memory hash.`);
  const hex = match[1];
  return path.join(memoryStorePaths(stackHome).objects, hex.slice(0, 2), hex);
};

const secureMkdir = async (directory: string) => {
  await mkdir(directory, { recursive: true });
};

const atomicWrite = async (target: string, bytes: Uint8Array) => {
  await secureMkdir(path.dirname(target));
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
 * Write a content-addressed, immutable Memory object. Idempotent: an object that
 * already exists (same hash) is left untouched. Verifies the written bytes.
 */
export const writeMemoryObject = async (options: {
  stackHome: string;
  contentHash: string;
  bytes: Uint8Array;
}): Promise<void> => {
  const { stackHome, contentHash, bytes } = options;
  if (hashBytes(bytes) !== contentHash)
    throw new MemoryStoreError(
      'hash-mismatch',
      'Refusing to store content that does not match its hash.',
    );
  const target = objectPath(stackHome, contentHash);
  await assertPathWithin({
    ownedRoot: memoryStorePaths(stackHome).objects,
    proposedPath: target,
  });
  const existing = await readFile(target).catch(() => undefined);
  if (existing) {
    if (hashBytes(existing) !== contentHash)
      throw new MemoryStoreError(
        'store-object-corrupt',
        'A stored Memory object is corrupt.',
      );
    return;
  }
  await atomicWrite(target, bytes);
  const verify = await readFile(target);
  if (hashBytes(verify) !== contentHash)
    throw new MemoryStoreError(
      'store-object-corrupt',
      'Stored Memory object failed verification.',
    );
};

/** Read a stored Memory object, verifying its hash. */
export const readMemoryObject = async (options: {
  stackHome: string;
  contentHash: string;
}): Promise<Uint8Array> => {
  const target = objectPath(options.stackHome, options.contentHash);
  await assertPathWithin({
    ownedRoot: memoryStorePaths(options.stackHome).objects,
    proposedPath: target,
  });
  let bytes: Uint8Array;
  try {
    bytes = await readFile(target);
  } catch {
    throw new MemoryStoreError(
      'store-object-missing',
      'A Memory object is missing from the store.',
    );
  }
  if (hashBytes(bytes) !== options.contentHash)
    throw new MemoryStoreError(
      'store-object-corrupt',
      'A stored Memory object is corrupt.',
    );
  return bytes;
};

/** Atomically commit the current backup manifest (the commit point of a backup). */
export const writeMemoryManifest = async (options: {
  stackHome: string;
  manifest: MemoryManifest;
}): Promise<void> => {
  const paths = memoryStorePaths(options.stackHome);
  const body = Buffer.from(
    `${JSON.stringify(memoryManifestSchema.parse(options.manifest), null, 2)}\n`,
    'utf8',
  );
  await secureMkdir(paths.manifests);
  await atomicWrite(paths.currentManifest, body);
};

/** Read the current backup manifest, or null when no backup exists. */
export const readMemoryManifest = async (
  stackHome: string,
): Promise<MemoryManifest | null> => {
  const paths = memoryStorePaths(stackHome);
  let raw: string;
  try {
    raw = await readFile(paths.currentManifest, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return memoryManifestSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new MemoryStoreError(
      'manifest-corrupt',
      'The Memory backup manifest is malformed.',
      { cause: error },
    );
  }
};
