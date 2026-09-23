import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverClaudeMemory } from './claude-adapter.js';
import { runMemoryBackup } from './backup.js';
import { planMemoryRestore, runMemoryRestore } from './restore.js';
import { readMemoryStatus } from './adapter.js';
import {
  MemoryStoreError,
  hashBytes,
  memoryStorePaths,
  readMemoryManifest,
  readMemoryObject,
  writeMemoryManifest,
  writeMemoryObject,
} from './store.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-memio-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const write = async (file: string, body: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
};

const snapshot = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const visit = async (d: string, prefix: string) => {
    for (const entry of (await readdir(d, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : 1),
    )) {
      const abs = path.join(d, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(abs, rel);
      else out.push(`${rel}:${await readFile(abs, 'utf8')}`);
    }
  };
  await visit(dir, '');
  return out;
};

const globalHome = async (root: string) => {
  const home = path.join(root, '.claude');
  await write(path.join(home, 'CLAUDE.md'), 'user instructions v1');
  await write(
    path.join(home, 'agent-memory', 'researcher', 'notes.md'),
    'agent notes',
  );
  return home;
};

describe('private memory store', () => {
  it('writes content-addressed objects and rejects hash mismatch', async () => {
    const stackHome = await temp();
    const bytes = Buffer.from('remember this');
    const contentHash = hashBytes(bytes);
    await writeMemoryObject({ stackHome, contentHash, bytes });
    expect([...(await readMemoryObject({ stackHome, contentHash }))]).toEqual([
      ...bytes,
    ]);
    await expect(
      writeMemoryObject({
        stackHome,
        contentHash: hashBytes(Buffer.from('other')),
        bytes,
      }),
    ).rejects.toBeInstanceOf(MemoryStoreError);
  });

  it('lives in a namespace disjoint from the Skill store', async () => {
    const stackHome = await temp();
    expect(memoryStorePaths(stackHome).root).toBe(
      path.join(path.resolve(stackHome), 'memory'),
    );
    expect(memoryStorePaths(stackHome).root).not.toContain(`${path.sep}store`);
  });
});

describe('backup', () => {
  it('captures memory into the store and commits a manifest (native untouched)', async () => {
    const root = await temp();
    const home = await globalHome(root);
    const stackHome = await temp();
    const before = await snapshot(home);

    const items = await discoverClaudeMemory({ claudeHome: home });
    const result = await runMemoryBackup({
      stackHome,
      items,
      now: () => new Date('2026-09-23T12:00:00.000Z'),
    });

    expect(result.files).toBe(2);
    // Native Claude memory is byte-for-byte unchanged (read-only backup).
    expect(await snapshot(home)).toEqual(before);
    // Manifest committed and readable; status reflects it.
    const status = await readMemoryStatus(stackHome);
    expect(status?.files).toBe(2);
    expect(status?.lastBackupAt).toBe('2026-09-23T12:00:00.000Z');
    // The manifest contains no absolute native paths.
    const manifest = await readMemoryManifest(stackHome);
    expect(JSON.stringify(manifest)).not.toContain(root);
  });

  it('does not commit a manifest when a source read fails midway', async () => {
    const root = await temp();
    const home = await globalHome(root);
    const stackHome = await temp();
    const items = await discoverClaudeMemory({ claudeHome: home });
    const first = items[0];
    if (!first) throw new Error('expected discovered items');
    // Point one item at a missing file to force a mid-backup failure.
    items[0] = { ...first, source: { path: path.join(root, 'gone.md') } };
    await expect(runMemoryBackup({ stackHome, items })).rejects.toBeTruthy();
    expect(await readMemoryManifest(stackHome)).toBeNull();
  });
});

describe('restore', () => {
  const backedUp = async () => {
    const root = await temp();
    const home = await globalHome(root);
    const stackHome = await temp();
    const items = await discoverClaudeMemory({ claudeHome: home });
    await runMemoryBackup({ stackHome, items });
    return { stackHome, root };
  };

  it('previews and restores absent targets, then verifies them', async () => {
    const { stackHome, root } = await backedUp();
    const targetHome = path.join(root, 'machineB', '.claude');

    const preview = await planMemoryRestore({
      stackHome,
      claudeHome: targetHome,
    });
    expect(preview.items.every((item) => item.status === 'restorable')).toBe(
      true,
    );

    const applied = await runMemoryRestore({
      stackHome,
      claudeHome: targetHome,
      apply: true,
    });
    expect(applied.items.every((item) => item.status === 'restored')).toBe(
      true,
    );
    expect(await readFile(path.join(targetHome, 'CLAUDE.md'), 'utf8')).toBe(
      'user instructions v1',
    );
  });

  it('is a no-op for identical existing targets', async () => {
    const { stackHome, root } = await backedUp();
    const targetHome = path.join(root, 'same', '.claude');
    await write(path.join(targetHome, 'CLAUDE.md'), 'user instructions v1');
    const preview = await planMemoryRestore({
      stackHome,
      claudeHome: targetHome,
    });
    expect(
      preview.items.find((item) => item.logicalId.endsWith('CLAUDE.md'))
        ?.status,
    ).toBe('identical');
  });

  it('reports a conflict and never overwrites differing memory', async () => {
    const { stackHome, root } = await backedUp();
    const targetHome = path.join(root, 'conflict', '.claude');
    await write(path.join(targetHome, 'CLAUDE.md'), 'DIFFERENT LOCAL EDITS');
    const applied = await runMemoryRestore({
      stackHome,
      claudeHome: targetHome,
      apply: true,
    });
    expect(
      applied.items.find((item) => item.logicalId.endsWith('CLAUDE.md'))
        ?.status,
    ).toBe('conflict');
    // The user's differing memory is preserved untouched.
    expect(await readFile(path.join(targetHome, 'CLAUDE.md'), 'utf8')).toBe(
      'DIFFERENT LOCAL EDITS',
    );
  });

  it('does not delete unmanaged memory that is absent from the backup', async () => {
    const { stackHome, root } = await backedUp();
    const targetHome = path.join(root, 'own', '.claude');
    const unmanaged = path.join(targetHome, 'agent-memory', 'other', 'keep.md');
    await write(unmanaged, 'PRE-EXISTING UNMANAGED');
    await runMemoryRestore({ stackHome, claudeHome: targetHome, apply: true });
    expect(await readFile(unmanaged, 'utf8')).toBe('PRE-EXISTING UNMANAGED');
  });

  it('reports project-not-found for project memory without a local project', async () => {
    const root = await temp();
    const home = path.join(root, '.claude');
    await write(
      path.join(home, 'projects', 'D--x-nado', 'memory', 'fact.md'),
      'fact',
    );
    const stackHome = await temp();
    const items = await discoverClaudeMemory({ claudeHome: home });
    await runMemoryBackup({ stackHome, items });
    const preview = await planMemoryRestore({
      stackHome,
      claudeHome: path.join(root, 'b', '.claude'),
    });
    expect(preview.items[0]?.status).toBe('project-not-found');
  });

  it('refuses a path-traversal restore target', async () => {
    const stackHome = await temp();
    const bytes = Buffer.from('evil');
    const contentHash = hashBytes(bytes);
    await writeMemoryObject({ stackHome, contentHash, bytes });
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-09-23T12:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'user-instructions',
            scope: 'global',
            logicalId: 'evil',
            contentHash,
            restoreTarget: { base: 'claude-home', relativePath: '../evil.md' },
            capturedAt: '2026-09-23T12:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    await expect(
      planMemoryRestore({
        stackHome,
        claudeHome: path.join(await temp(), '.claude'),
      }),
    ).rejects.toBeTruthy();
  });
});
