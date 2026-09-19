import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class PathFenceError extends Error {
  readonly code = 'path-outside-owned-root';

  constructor() {
    super('The proposed filesystem path is outside the owned root.');
    this.name = 'PathFenceError';
  }
}

const canonicalize = async (input: string): Promise<string> => {
  const resolved = path.resolve(input);
  const suffix: string[] = [];
  let cursor = resolved;
  while (true) {
    try {
      const canonical = await realpath(cursor);
      return path.resolve(canonical, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
};

const comparisonPath = (value: string, platform: NodeJS.Platform) =>
  platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;

export const pathsEqual = async (options: {
  left: string;
  right: string;
  platform?: NodeJS.Platform;
}) => {
  const platform = options.platform ?? process.platform;
  return (
    comparisonPath(await canonicalize(options.left), platform) ===
    comparisonPath(await canonicalize(options.right), platform)
  );
};

export const assertPathWithin = async (options: {
  ownedRoot: string;
  proposedPath: string;
  allowRoot?: boolean;
  platform?: NodeJS.Platform;
}): Promise<string> => {
  const platform = options.platform ?? process.platform;
  const canonicalRoot = comparisonPath(
    await canonicalize(options.ownedRoot),
    platform,
  );
  const canonicalProposed = comparisonPath(
    await canonicalize(options.proposedPath),
    platform,
  );
  const relative = path.relative(canonicalRoot, canonicalProposed);
  const isRoot = relative === '';
  const escaped =
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);
  if (escaped || (isRoot && !options.allowRoot)) throw new PathFenceError();
  return path.resolve(options.proposedPath);
};

export const pathIsWithin = async (options: {
  ownedRoot: string;
  proposedPath: string;
  allowRoot?: boolean;
  platform?: NodeJS.Platform;
}): Promise<boolean> => {
  try {
    await assertPathWithin(options);
    return true;
  } catch (error) {
    if (error instanceof PathFenceError) return false;
    throw error;
  }
};

export type OwnedTestRoot = {
  readonly rootPath: string;
  assertMutationPath(proposedPath: string): Promise<string>;
  createDirectory(directory: string): Promise<void>;
  writeText(file: string, contents: string): Promise<void>;
  cleanupPath(target: string): Promise<void>;
  cleanup(): Promise<void>;
};

export const createOwnedTestRoot = async (
  prefix = 'stack-test-',
): Promise<OwnedTestRoot> => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), prefix));
  let owned = true;
  const assertOwned = (proposedPath: string, allowRoot = false) => {
    if (!owned) throw new PathFenceError();
    return assertPathWithin({ ownedRoot: rootPath, proposedPath, allowRoot });
  };
  return {
    rootPath,
    assertMutationPath: (proposedPath) => assertOwned(proposedPath),
    createDirectory: async (directory) => {
      await assertOwned(directory);
      await mkdir(directory, { recursive: true });
    },
    writeText: async (file, contents) => {
      await assertOwned(file);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents, 'utf8');
    },
    cleanupPath: async (target) => {
      await assertOwned(target);
      await rm(target, { recursive: true, force: true });
    },
    cleanup: async () => {
      await assertOwned(rootPath, true);
      try {
        await lstat(rootPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          owned = false;
          return;
        }
        throw error;
      }
      await rm(rootPath, { recursive: true, force: true });
      owned = false;
    },
  };
};
