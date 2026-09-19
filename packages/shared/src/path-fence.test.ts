import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PathFenceError,
  assertPathWithin,
  createOwnedTestRoot,
} from './path-fence.js';

describe('path ownership fence', () => {
  it('accepts descendants but rejects the root, parent, sibling, and traversal escapes', async () => {
    const owned = await createOwnedTestRoot('stack-fence-');
    const child = path.join(owned.rootPath, 'nested', 'fixture');
    await expect(owned.assertMutationPath(child)).resolves.toBe(child);
    for (const unsafe of [
      owned.rootPath,
      path.dirname(owned.rootPath),
      path.join(path.dirname(owned.rootPath), 'sibling'),
      path.join(owned.rootPath, '..', 'escape'),
    ])
      await expect(owned.assertMutationPath(unsafe)).rejects.toBeInstanceOf(
        PathFenceError,
      );
    await owned.cleanup();
  });

  it('uses case-insensitive canonical containment for Windows semantics', async () => {
    const owned = await createOwnedTestRoot('stack-fence-case-');
    const differentlyCased = path.join(owned.rootPath, 'Child').toUpperCase();
    await expect(
      assertPathWithin({
        ownedRoot: owned.rootPath.toLowerCase(),
        proposedPath: differentlyCased,
        platform: 'win32',
      }),
    ).resolves.toBe(path.resolve(differentlyCased));
    const foreign = await createOwnedTestRoot('stack-fence-real-home-');
    await expect(
      assertPathWithin({
        ownedRoot: owned.rootPath.toUpperCase(),
        proposedPath: path.join(foreign.rootPath.toLowerCase(), '.agents'),
        platform: 'win32',
      }),
    ).rejects.toBeInstanceOf(PathFenceError);
    await owned.cleanup();
    await foreign.cleanup();
  });

  it('rejects a symlink alias that resolves outside the owned root where supported', async () => {
    const owned = await createOwnedTestRoot('stack-fence-alias-');
    const outside = await createOwnedTestRoot('stack-fence-outside-');
    const alias = path.join(owned.rootPath, 'alias');
    try {
      await (
        await import('node:fs/promises')
      ).symlink(
        outside.rootPath,
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      await owned.cleanup();
      await outside.cleanup();
      return;
    }
    await expect(
      owned.assertMutationPath(path.join(alias, 'fixture')),
    ).rejects.toBeInstanceOf(PathFenceError);
    await owned.cleanup();
    await outside.cleanup();
  });

  it('refuses fixture writes and cleanup outside its created root', async () => {
    const owned = await createOwnedTestRoot('stack-fence-cleanup-');
    const outsideOwned = await createOwnedTestRoot('stack-fence-foreign-');
    const outside = path.join(outsideOwned.rootPath, 'do-not-touch');
    await outsideOwned.createDirectory(outside);
    const sentinel = path.join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'unchanged');
    await expect(owned.assertMutationPath(sentinel)).rejects.toBeInstanceOf(
      PathFenceError,
    );
    await expect(owned.cleanupPath(outside)).rejects.toBeInstanceOf(
      PathFenceError,
    );
    await expect(access(sentinel)).resolves.toBeUndefined();
    await owned.cleanup();
    await outsideOwned.cleanup();
  });
});
