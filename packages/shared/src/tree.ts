import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const ignoredFiles = new Set(['.DS_Store', 'Thumbs.db']);

export type SkillTreeEntry =
  | { relativePath: string; type: 'file'; content: Buffer }
  | { relativePath: string; type: 'symlink'; target: string };

export class UnsafeTreePathError extends Error {
  readonly code = 'unsafe-tree-path';

  constructor(public readonly relativePath: string) {
    super(`Unsafe Skill tree path: ${relativePath}`);
    this.name = 'UnsafeTreePathError';
  }
}

export class UnsupportedTreeSymlinkError extends Error {
  readonly code = 'unsupported-tree-symlink';

  constructor(
    public readonly relativePath: string,
    options?: ErrorOptions,
  ) {
    super(`Could not recreate nested symlink: ${relativePath}`, options);
    this.name = 'UnsupportedTreeSymlinkError';
  }
}

export const validateTreePath = (relativePath: string): string => {
  const normalized = relativePath.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..') ||
    path.posix.normalize(normalized) !== normalized
  )
    throw new UnsafeTreePathError(relativePath);
  return normalized;
};

export const enumerateSkillTree = async (
  root: string,
  directory = root,
): Promise<SkillTreeEntry[]> => {
  const results: SkillTreeEntry[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || ignoredFiles.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relativePath = validateTreePath(
      path.relative(root, absolute).split(path.sep).join('/'),
    );
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink())
      results.push({
        relativePath,
        type: 'symlink',
        target: await readlink(absolute),
      });
    else if (stats.isDirectory())
      results.push(...(await enumerateSkillTree(root, absolute)));
    else if (stats.isFile())
      results.push({
        relativePath,
        type: 'file',
        content: await readFile(absolute),
      });
  }
  return results.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, 'en'),
  );
};

export const hashSkillTreeEntries = (entries: SkillTreeEntry[]): string => {
  const hash = createHash('sha256');
  for (const entry of [...entries].sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0,
  )) {
    validateTreePath(entry.relativePath);
    hash
      .update(entry.type)
      .update('\0')
      .update(entry.relativePath)
      .update('\0');
    hash
      .update(entry.type === 'file' ? entry.content : entry.target)
      .update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
};

export const hashSkillDirectory = async (
  directory: string,
): Promise<{ hash: string; nestedSymlinks: string[] }> => {
  const entries = await enumerateSkillTree(directory);
  return {
    hash: hashSkillTreeEntries(entries),
    nestedSymlinks: entries
      .filter((entry) => entry.type === 'symlink')
      .map((entry) => entry.relativePath),
  };
};

export const copySkillTreeEntries = async (
  entries: SkillTreeEntry[],
  target: string,
): Promise<void> => {
  await mkdir(target, { recursive: true });
  const targetRoot = path.resolve(target);
  for (const entry of entries) {
    const relativePath = validateTreePath(entry.relativePath);
    const destination = path.resolve(targetRoot, ...relativePath.split('/'));
    const targetPrefix = `${targetRoot}${path.sep}`;
    if (
      destination !== targetRoot &&
      !(process.platform === 'win32'
        ? destination.toLowerCase().startsWith(targetPrefix.toLowerCase())
        : destination.startsWith(targetPrefix))
    )
      throw new UnsafeTreePathError(entry.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    if (entry.type === 'file') await writeFile(destination, entry.content);
    else
      try {
        await symlink(entry.target, destination);
      } catch (error) {
        throw new UnsupportedTreeSymlinkError(entry.relativePath, {
          cause: error,
        });
      }
  }
};

export const copySkillTree = async (
  source: string,
  target: string,
): Promise<void> =>
  copySkillTreeEntries(await enumerateSkillTree(source), target);
