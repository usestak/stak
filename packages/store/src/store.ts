import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  copySkillTree,
  hashSkillDirectory,
  UnsupportedTreeSymlinkError,
  UnsafeTreePathError,
} from '@stack/shared';
import {
  contentStoreMetadataSchema,
  storeVerificationSchema,
} from '@stack/spec';
import type { StoreVerification } from '@stack/spec';

export class StackStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StackStoreError';
  }
}

export class UnsafeStorePathError extends StackStoreError {
  constructor(public readonly contentHash: string) {
    super('unsafe-store-path', `Invalid content-store key: ${contentHash}`);
    this.name = 'UnsafeStorePathError';
  }
}

export class ContentHashMismatchError extends StackStoreError {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      'content-hash-mismatch',
      `Expected ${expected}, but Skill content hashes to ${actual}.`,
    );
    this.name = 'ContentHashMismatchError';
  }
}

export class StoreObjectCorruptError extends StackStoreError {
  constructor(public readonly verification: StoreVerification) {
    super(
      'store-object-corrupt',
      verification.message ??
        `Stored object ${verification.contentHash} is corrupt.`,
    );
    this.name = 'StoreObjectCorruptError';
  }
}

export class StoreObjectMissingError extends StackStoreError {
  constructor(public readonly contentHash: string) {
    super('store-object-missing', `Stored object ${contentHash} is missing.`);
    this.name = 'StoreObjectMissingError';
  }
}

export class MaterializationTargetExistsError extends StackStoreError {
  constructor(public readonly targetPath: string) {
    super(
      'materialization-target-exists',
      `Materialization target already exists: ${targetPath}`,
    );
    this.name = 'MaterializationTargetExistsError';
  }
}

export class MaterializationFailedError extends StackStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('materialization-failed', message, options);
    this.name = 'MaterializationFailedError';
  }
}

export class UnsupportedSymlinkRestorationError extends StackStoreError {
  constructor(options?: ErrorOptions) {
    super(
      'unsupported-symlink-restoration',
      'This platform could not recreate nested Skill symlinks exactly.',
      options,
    );
    this.name = 'UnsupportedSymlinkRestorationError';
  }
}

const parseHash = (contentHash: string): string => {
  const match = /^sha256:([0-9a-f]{64})$/.exec(contentHash);
  if (!match?.[1]) throw new UnsafeStorePathError(contentHash);
  return match[1];
};

export const contentObjectPaths = (stackHome: string, contentHash: string) => {
  const hexadecimal = parseHash(contentHash);
  const objectDirectory = path.join(
    path.resolve(stackHome),
    'store',
    'sha256',
    hexadecimal.slice(0, 2),
    hexadecimal,
  );
  return {
    objectDirectory,
    contentPath: path.join(objectDirectory, 'content'),
    metadataPath: path.join(objectDirectory, 'object.json'),
  };
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR'
    )
      return false;
    throw error;
  }
};

export const verifyStoredSkill = async (options: {
  stackHome: string;
  contentHash: string;
}): Promise<StoreVerification> => {
  const paths = contentObjectPaths(options.stackHome, options.contentHash);
  if (!(await exists(paths.objectDirectory)))
    return storeVerificationSchema.parse({
      state: 'missing',
      contentHash: options.contentHash,
      code: 'object-missing',
      message: 'Content-store object does not exist.',
      objectPath: paths.objectDirectory,
    });
  if (!(await exists(paths.metadataPath)))
    return storeVerificationSchema.parse({
      state: 'corrupt',
      contentHash: options.contentHash,
      code: 'metadata-missing',
      message: 'Content-store metadata is missing.',
      objectPath: paths.objectDirectory,
    });
  let metadata: ReturnType<typeof contentStoreMetadataSchema.parse>;
  try {
    metadata = contentStoreMetadataSchema.parse(
      JSON.parse(await readFile(paths.metadataPath, 'utf8')),
    );
  } catch {
    return storeVerificationSchema.parse({
      state: 'corrupt',
      contentHash: options.contentHash,
      code: 'metadata-malformed',
      message: 'Content-store metadata is malformed.',
      objectPath: paths.objectDirectory,
    });
  }
  if (metadata.contentHash !== options.contentHash)
    return storeVerificationSchema.parse({
      state: 'corrupt',
      contentHash: options.contentHash,
      code: 'metadata-hash-mismatch',
      message: 'Content-store metadata names a different hash.',
      objectPath: paths.objectDirectory,
    });
  if (!(await exists(paths.contentPath)))
    return storeVerificationSchema.parse({
      state: 'corrupt',
      contentHash: options.contentHash,
      code: 'content-missing',
      message: 'Content-store content directory is missing.',
      objectPath: paths.objectDirectory,
    });
  try {
    const actual = (await hashSkillDirectory(paths.contentPath)).hash;
    if (actual !== options.contentHash)
      return storeVerificationSchema.parse({
        state: 'corrupt',
        contentHash: options.contentHash,
        code: 'content-hash-mismatch',
        message: `Stored content hashes to ${actual}.`,
        objectPath: paths.objectDirectory,
      });
  } catch (error) {
    return storeVerificationSchema.parse({
      state: 'corrupt',
      contentHash: options.contentHash,
      code: 'content-unreadable',
      message: error instanceof Error ? error.message : String(error),
      objectPath: paths.objectDirectory,
    });
  }
  return storeVerificationSchema.parse({
    state: 'available',
    contentHash: options.contentHash,
    objectPath: paths.objectDirectory,
  });
};

export type IngestSkillOptions = {
  stackHome: string;
  sourcePath: string;
  expectedContentHash: string;
  now?: () => Date;
};
export type IngestSkillResult = {
  contentHash: string;
  objectPath: string;
  contentPath: string;
  reused: boolean;
};

export const ingestSkill = async (
  options: IngestSkillOptions,
): Promise<IngestSkillResult> => {
  const paths = contentObjectPaths(
    options.stackHome,
    options.expectedContentHash,
  );
  if (await exists(paths.objectDirectory)) {
    const verification = await verifyStoredSkill({
      stackHome: options.stackHome,
      contentHash: options.expectedContentHash,
    });
    if (verification.state !== 'available')
      throw new StoreObjectCorruptError(verification);
    return {
      contentHash: options.expectedContentHash,
      objectPath: paths.objectDirectory,
      contentPath: paths.contentPath,
      reused: true,
    };
  }
  const sourceHash = (await hashSkillDirectory(options.sourcePath)).hash;
  if (sourceHash !== options.expectedContentHash)
    throw new ContentHashMismatchError(options.expectedContentHash, sourceHash);
  const staging = `${paths.objectDirectory}.${randomUUID()}.tmp`;
  const stagingContent = path.join(staging, 'content');
  try {
    await mkdir(path.dirname(paths.objectDirectory), { recursive: true });
    await copySkillTree(options.sourcePath, stagingContent);
    const stagedHash = (await hashSkillDirectory(stagingContent)).hash;
    if (stagedHash !== options.expectedContentHash)
      throw new ContentHashMismatchError(
        options.expectedContentHash,
        stagedHash,
      );
    const metadata = contentStoreMetadataSchema.parse({
      schemaVersion: 1,
      algorithm: 'sha256',
      contentHash: options.expectedContentHash,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      kind: 'skill',
    });
    await writeFile(
      path.join(staging, 'object.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8',
    );
    try {
      await rename(staging, paths.objectDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const verification = await verifyStoredSkill({
        stackHome: options.stackHome,
        contentHash: options.expectedContentHash,
      });
      if (verification.state !== 'available')
        throw new StoreObjectCorruptError(verification);
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof UnsupportedTreeSymlinkError)
      throw new UnsupportedSymlinkRestorationError({ cause: error });
    throw error;
  }
  return {
    contentHash: options.expectedContentHash,
    objectPath: paths.objectDirectory,
    contentPath: paths.contentPath,
    reused: false,
  };
};

export type MaterializeStoredSkillOptions = {
  stackHome: string;
  contentHash: string;
  targetPath: string;
};

export const materializeStoredSkill = async (
  options: MaterializeStoredSkillOptions,
): Promise<{ contentHash: string; targetPath: string }> => {
  if (await exists(options.targetPath))
    throw new MaterializationTargetExistsError(options.targetPath);
  const verification = await verifyStoredSkill(options);
  if (verification.state === 'missing')
    throw new StoreObjectMissingError(options.contentHash);
  if (verification.state === 'corrupt')
    throw new StoreObjectCorruptError(verification);
  const paths = contentObjectPaths(options.stackHome, options.contentHash);
  const parent = path.dirname(path.resolve(options.targetPath));
  const staging = path.join(
    parent,
    `.${path.basename(options.targetPath)}.${randomUUID()}.tmp`,
  );
  try {
    await mkdir(parent, { recursive: true });
    await copySkillTree(paths.contentPath, staging);
    const actual = (await hashSkillDirectory(staging)).hash;
    if (actual !== options.contentHash)
      throw new ContentHashMismatchError(options.contentHash, actual);
    await rename(staging, options.targetPath);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (
      error instanceof ContentHashMismatchError ||
      error instanceof UnsafeTreePathError
    )
      throw error;
    if (error instanceof UnsupportedTreeSymlinkError)
      throw new UnsupportedSymlinkRestorationError({ cause: error });
    throw new MaterializationFailedError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  return { contentHash: options.contentHash, targetPath: options.targetPath };
};
