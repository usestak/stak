import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

const ignoredFiles = new Set(['.DS_Store', 'Thumbs.db']);
type HashEntry =
  | { relativePath: string; type: 'file'; content: Buffer }
  | { relativePath: string; type: 'symlink'; target: string };

const enumerate = async (
  root: string,
  directory = root,
): Promise<HashEntry[]> => {
  const results: HashEntry[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || ignoredFiles.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relativePath = path
      .relative(root, absolute)
      .split(path.sep)
      .join('/');
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink())
      results.push({
        relativePath,
        type: 'symlink',
        target: await readlink(absolute),
      });
    else if (stats.isDirectory())
      results.push(...(await enumerate(root, absolute)));
    else if (stats.isFile())
      results.push({
        relativePath,
        type: 'file',
        content: await readFile(absolute),
      });
  }
  return results;
};

export const hashSkillDirectory = async (
  directory: string,
): Promise<{ hash: string; nestedSymlinks: string[] }> => {
  const entries = (await enumerate(directory)).sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0,
  );
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash
      .update(entry.type)
      .update('\0')
      .update(entry.relativePath)
      .update('\0');
    hash
      .update(entry.type === 'file' ? entry.content : entry.target)
      .update('\0');
  }
  return {
    hash: `sha256:${hash.digest('hex')}`,
    nestedSymlinks: entries
      .filter((entry) => entry.type === 'symlink')
      .map((entry) => entry.relativePath),
  };
};
