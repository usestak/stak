import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { atomicWriteFile } from '../remote/secure-file.js';
import { memoryStorePaths } from '../store.js';
import {
  canonicalMainManifestSchema,
  emptyCanonicalMain,
  type CanonicalMainManifest,
} from './domain.js';

export class CanonicalStoreError extends Error {
  constructor(
    public readonly code:
      'main-corrupt' | 'base-corrupt' | 'merge-corrupt' | 'projection-corrupt',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CanonicalStoreError';
  }
}

export const canonicalStorePaths = (stackHome: string) => {
  const root = path.join(memoryStorePaths(stackHome).root, 'canonical');
  const projectionsRoot = path.join(
    memoryStorePaths(stackHome).root,
    'projections',
  );
  return {
    root,
    main: path.join(root, 'main.json'),
    base: path.join(root, 'base.json'),
    merge: path.join(root, 'merge.json'),
    projectionsRoot,
    projections: (adapterId: string) =>
      path.join(projectionsRoot, `${adapterId}.json`),
  };
};

const readJson = async (file: string): Promise<unknown | undefined> => {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(raw) as unknown;
};

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await atomicWriteFile(
    file,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
  );
};

export const readCanonicalMain = async (
  stackHome: string,
): Promise<CanonicalMainManifest> => {
  const raw = await readJson(canonicalStorePaths(stackHome).main);
  if (raw === undefined) return emptyCanonicalMain();
  try {
    return canonicalMainManifestSchema.parse(raw);
  } catch (error) {
    throw new CanonicalStoreError(
      'main-corrupt',
      'Canonical Memory manifest is malformed.',
      { cause: error },
    );
  }
};

export const writeCanonicalMain = async (
  stackHome: string,
  main: CanonicalMainManifest,
): Promise<void> =>
  writeJson(
    canonicalStorePaths(stackHome).main,
    canonicalMainManifestSchema.parse(main),
  );

export type CanonicalBase = {
  generation: number;
  main: CanonicalMainManifest;
  /** `globalManifestDigest` of this machine's global Memory as of its last
   * sync (I1 re-fix). Global Memory is never pulled onto an established
   * machine, so "changed locally" means "differs from this", never "differs
   * from Cloud". Absent on bases written before it existed (legacy rule: see
   * `pushCanonicalMemory`). */
  globalDigest?: string;
};

const canonicalBaseSchema = z.object({
  generation: z.number().int().nonnegative(),
  main: canonicalMainManifestSchema,
  globalDigest: z.string().optional(),
});

export const readCanonicalBase = async (
  stackHome: string,
): Promise<CanonicalBase | null> => {
  const raw = await readJson(canonicalStorePaths(stackHome).base);
  if (raw === undefined) return null;
  try {
    const { globalDigest, ...rest } = canonicalBaseSchema.parse(raw);
    return globalDigest !== undefined ? { ...rest, globalDigest } : rest;
  } catch (error) {
    throw new CanonicalStoreError(
      'base-corrupt',
      'Canonical Memory base is malformed.',
      {
        cause: error,
      },
    );
  }
};

export const writeCanonicalBase = async (
  stackHome: string,
  base: CanonicalBase,
): Promise<void> =>
  writeJson(
    canonicalStorePaths(stackHome).base,
    canonicalBaseSchema.parse(base),
  );

export const readPendingMerge = async <T>(
  stackHome: string,
  schema: z.ZodType<T>,
): Promise<T | null> => {
  const raw = await readJson(canonicalStorePaths(stackHome).merge);
  if (raw === undefined) return null;
  try {
    return schema.parse(raw);
  } catch (error) {
    throw new CanonicalStoreError(
      'merge-corrupt',
      'Pending Memory merge is malformed.',
      { cause: error },
    );
  }
};

export const writePendingMerge = async (
  stackHome: string,
  merge: unknown,
): Promise<void> => writeJson(canonicalStorePaths(stackHome).merge, merge);

export const clearPendingMerge = async (stackHome: string): Promise<void> => {
  const { rm } = await import('node:fs/promises');
  await rm(canonicalStorePaths(stackHome).merge, { force: true });
};

export type ProjectionFile = {
  schemaVersion: 1;
  projects: Record<string, Record<string, string>>;
};

const projectionFileSchema: z.ZodType<ProjectionFile> = z.object({
  schemaVersion: z.literal(1),
  projects: z.record(z.string(), z.record(z.string(), z.string())),
});

export const emptyProjectionFile = (): ProjectionFile => ({
  schemaVersion: 1,
  projects: {},
});

export const readProjection = async (
  stackHome: string,
  adapterId: string,
): Promise<ProjectionFile> => {
  const raw = await readJson(
    canonicalStorePaths(stackHome).projections(adapterId),
  );
  if (raw === undefined) return emptyProjectionFile();
  try {
    return projectionFileSchema.parse(raw);
  } catch (error) {
    throw new CanonicalStoreError(
      'projection-corrupt',
      `Memory projection for adapter "${adapterId}" is malformed.`,
      { cause: error },
    );
  }
};

export const writeProjection = async (
  stackHome: string,
  adapterId: string,
  file: ProjectionFile,
): Promise<void> =>
  writeJson(
    canonicalStorePaths(stackHome).projections(adapterId),
    projectionFileSchema.parse(file),
  );
