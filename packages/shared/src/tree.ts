import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
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

/**
 * Comparison key for tree paths. Case- and Unicode-normalization-insensitive because the
 * default macOS and Windows filesystems are: `A` and `a` (or NFC/NFD spellings) name the
 * same file there, so they must collide here too.
 */
const treePathKey = (relativePath: string): string =>
  relativePath.normalize('NFC').toLowerCase();

/**
 * Reject entry sets that could make a copy write somewhere other than where each entry's
 * path says: an entry nested beneath a symlink entry (writing `link/file` follows `link`,
 * which is how chained symlinks escaped the target), or two entries naming the same path
 * (a file written over an earlier symlink is written through it). A tree enumerated from
 * disk never has either — `enumerateSkillTree` does not descend into symlinks — so this
 * only ever rejects crafted input.
 */
export const assertSafeTreeLayout = (entries: SkillTreeEntry[]): void => {
  const symlinkKeys = new Set(
    entries
      .filter((entry) => entry.type === 'symlink')
      .map((entry) => treePathKey(validateTreePath(entry.relativePath))),
  );
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = treePathKey(validateTreePath(entry.relativePath));
    if (seen.has(key)) throw new UnsafeTreePathError(entry.relativePath);
    seen.add(key);
    const segments = key.split('/');
    for (let depth = 1; depth < segments.length; depth += 1)
      if (symlinkKeys.has(segments.slice(0, depth).join('/')))
        throw new UnsafeTreePathError(entry.relativePath);
  }
};

const isWithin = (root: string, candidate: string): boolean => {
  if (candidate === root) return true;
  const prefix = `${root}${path.sep}`;
  return process.platform === 'win32'
    ? candidate.toLowerCase().startsWith(prefix.toLowerCase())
    : candidate.startsWith(prefix);
};

export const copySkillTreeEntries = async (
  entries: SkillTreeEntry[],
  target: string,
): Promise<void> => {
  assertSafeTreeLayout(entries);
  await mkdir(target, { recursive: true });
  const targetRoot = path.resolve(target);
  const realTargetRoot = await realpath(targetRoot);
  // Files first, symlinks last: no write in this copy can ever traverse a link it created.
  const ordered = [
    ...entries.filter((entry) => entry.type === 'file'),
    ...entries.filter((entry) => entry.type === 'symlink'),
  ];
  for (const entry of ordered) {
    const relativePath = validateTreePath(entry.relativePath);
    const destination = path.resolve(targetRoot, ...relativePath.split('/'));
    if (destination === targetRoot || !isWithin(targetRoot, destination))
      throw new UnsafeTreePathError(entry.relativePath);
    const parent = path.dirname(destination);
    await mkdir(parent, { recursive: true });
    // Belt and braces against anything pre-existing in the target: the directory we are
    // about to write into must really be inside it, not reached through a link.
    if (!isWithin(realTargetRoot, await realpath(parent)))
      throw new UnsafeTreePathError(entry.relativePath);
    if (entry.type === 'file')
      // `wx`: never write through, or over, something already at this path.
      await writeFile(destination, entry.content, { flag: 'wx' });
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
