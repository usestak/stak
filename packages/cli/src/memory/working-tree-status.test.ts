import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  emptyRegistry,
  encodeClaudeProjectKey,
  hashBytes,
  resolveOrMintProject,
  runMemoryBackup,
  setBinding,
  type DiscoveredMemoryItem,
} from '@stack/memory';

import { computeMemoryWorkingTreeStatus } from './working-tree-status.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-memwt-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

// A real scan (`discoverClaudeMemory`) computes `contentHash` fresh from the file's
// current bytes at discovery time — so a test fixture must do the same, from whatever
// `body` the file actually holds right now, never a hardcoded/stale value.
const item = (filePath: string, body: string): DiscoveredMemoryItem => ({
  provider: 'claude',
  kind: 'agent-memory',
  scope: 'global',
  logicalId: 'claude/agent-memory/notes.md',
  contentHash: hashBytes(Buffer.from(body)),
  restoreTarget: { base: 'claude-home', relativePath: 'notes.md' },
  source: { path: filePath },
  capturedAt: '2026-01-01T00:00:00.000Z',
  sensitivity: 'private',
});

describe('computeMemoryWorkingTreeStatus — MACHINE vs MAIN, read-only', () => {
  it('reports discovered (not yet staged) when no local manifest exists', async () => {
    const stackHome = await temp();
    const nativeHome = await temp();
    const filePath = path.join(nativeHome, 'notes.md');
    await writeFile(filePath, 'hello\n', 'utf8');

    const status = await computeMemoryWorkingTreeStatus({
      stackHome,
      nativeItems: [item(filePath, 'hello\n')],
    });
    expect(status).toEqual({ state: 'no-manifest', discovered: 1 });
  });

  it('reports clean when native Memory matches the staged manifest exactly', async () => {
    const stackHome = await temp();
    const nativeHome = await temp();
    const filePath = path.join(nativeHome, 'notes.md');
    await writeFile(filePath, 'hello\n', 'utf8');
    await runMemoryBackup({ stackHome, items: [item(filePath, 'hello\n')] });

    const status = await computeMemoryWorkingTreeStatus({
      stackHome,
      nativeItems: [item(filePath, 'hello\n')],
    });
    expect(status).toEqual({ state: 'clean' });
  });

  it('reports changes not added when native Memory diverges from the staged manifest', async () => {
    const stackHome = await temp();
    const nativeHome = await temp();
    const filePath = path.join(nativeHome, 'notes.md');
    await writeFile(filePath, 'hello\n', 'utf8');
    await runMemoryBackup({ stackHome, items: [item(filePath, 'hello\n')] });

    await writeFile(filePath, 'changed\n', 'utf8');
    const status = await computeMemoryWorkingTreeStatus({
      stackHome,
      nativeItems: [item(filePath, 'changed\n')],
    });
    expect(status).toEqual({ state: 'changes-not-added', changed: 1 });
  });

  it('never mutates the local manifest or the content store', async () => {
    const stackHome = await temp();
    const nativeHome = await temp();
    const filePath = path.join(nativeHome, 'notes.md');
    await writeFile(filePath, 'hello\n', 'utf8');
    await runMemoryBackup({ stackHome, items: [item(filePath, 'hello\n')] });

    await writeFile(filePath, 'changed\n', 'utf8');
    await computeMemoryWorkingTreeStatus({
      stackHome,
      nativeItems: [item(filePath, 'changed\n')],
    });

    // The manifest must still reflect the originally staged content, not the new native
    // bytes — a read-only status check must never silently re-stage.
    const { readMemoryManifest } = await import('@stack/memory');
    const manifest = await readMemoryManifest(stackHome);
    expect(manifest?.items[0]?.contentHash).toBe(hashBytes(Buffer.from('hello\n')));
  });

  it('does not count a manifest item missing from native scan (carried-forward/unavailable) as a change', async () => {
    const stackHome = await temp();
    const nativeHome = await temp();
    const filePath = path.join(nativeHome, 'notes.md');
    await writeFile(filePath, 'hello\n', 'utf8');
    await runMemoryBackup({ stackHome, items: [item(filePath, 'hello\n')] });

    // Native scan now finds nothing (e.g. an unavailable project) — this is not a "change
    // not added", it's a presence question `add .`'s composition already handles elsewhere.
    const status = await computeMemoryWorkingTreeStatus({ stackHome, nativeItems: [] });
    expect(status).toEqual({ state: 'clean' });
  });
});

describe('computeMemoryWorkingTreeStatus — relocated/re-cloned Project identity (real production case)', () => {
  // `runMemoryBackup` re-reads bytes from `source.path` at commit time, so every
  // fixture here writes a REAL file — never a fake path.
  const projectItem = async (
    vendorKey: string,
    fileDir: string,
    body: string,
  ): Promise<DiscoveredMemoryItem> => {
    const filePath = path.join(fileDir, 'f.md');
    await writeFile(filePath, body, 'utf8');
    return {
      provider: 'claude',
      kind: 'auto-memory',
      scope: 'project',
      logicalId: `claude/auto-memory/local:${vendorKey}/feedback_tdd_backend_adapters.md`,
      project: { kind: 'local', vendorKey },
      contentHash: hashBytes(Buffer.from(body)),
      restoreTarget: {
        base: 'claude-project-memory',
        relativePath: 'feedback_tdd_backend_adapters.md',
      },
      source: { path: filePath },
      capturedAt: '2026-10-20T00:00:00.000Z',
      sensitivity: 'private',
    };
  };

  const reconciledRegistry = async (oldVendorKey: string, newDir: string) => {
    const minted = resolveOrMintProject(
      emptyRegistry(),
      { kind: 'local', vendorKey: oldVendorKey },
      () => 'prj_swftoriginal0000000000001',
    );
    return setBinding(minted.registry, {
      projectId: minted.projectId,
      dir: path.resolve(newDir),
      boundAt: '2026-10-20T00:00:00.000Z',
      provenance: 'user-map',
    });
  };

  it('A/E: Memory staged at the ORIGINAL location, now only discovered at the mapped NEW location — clean (the true fresh-machine case)', async () => {
    const stackHome = await temp();
    const oldVendorKey = 'C--Users-NT-Desktop-swft';
    const oldDir = await temp();
    const newDir = await temp();
    await runMemoryBackup({
      stackHome,
      items: [await projectItem(oldVendorKey, oldDir, 'feedback content')],
    });

    const registry = await reconciledRegistry(oldVendorKey, newDir);
    const newVendorKey = encodeClaudeProjectKey(path.resolve(newDir));
    const status = await computeMemoryWorkingTreeStatus({
      stackHome,
      nativeItems: [await projectItem(newVendorKey, newDir, 'feedback content')],
      registry,
    });
    expect(status).toEqual({ state: 'clean' });
  });

  it('old + new native locations both present, same Project/path/hash — clean, never "1 change not added"', async () => {
    const stackHome = await temp();
    const oldVendorKey = 'C--Users-NT-Desktop-swft';
    const oldDir = await temp();
    const newDir = await temp();
    await runMemoryBackup({
      stackHome,
      items: [await projectItem(oldVendorKey, oldDir, 'feedback content')],
    });

    const registry = await reconciledRegistry(oldVendorKey, newDir);
    const newVendorKey = encodeClaudeProjectKey(path.resolve(newDir));
    const status = await computeMemoryWorkingTreeStatus({
      stackHome,
      nativeItems: [
        await projectItem(oldVendorKey, oldDir, 'feedback content'),
        await projectItem(newVendorKey, newDir, 'feedback content'),
      ],
      registry,
    });
    expect(status).toEqual({ state: 'clean' });
  });

  it('old + new native locations present but content genuinely DIFFERS — surfaces as a change, never silently resolved', async () => {
    const stackHome = await temp();
    const oldVendorKey = 'C--Users-NT-Desktop-swft';
    const oldDir = await temp();
    const newDir = await temp();
    await runMemoryBackup({
      stackHome,
      items: [await projectItem(oldVendorKey, oldDir, 'old content')],
    });

    const registry = await reconciledRegistry(oldVendorKey, newDir);
    const newVendorKey = encodeClaudeProjectKey(path.resolve(newDir));
    const status = await computeMemoryWorkingTreeStatus({
      stackHome,
      nativeItems: [
        await projectItem(oldVendorKey, oldDir, 'old content'),
        await projectItem(newVendorKey, newDir, 'edited content'),
      ],
      registry,
    });
    expect(status).toEqual({ state: 'changes-not-added', changed: 1 });
  });

  it('a machine binding change ALONE (no content change) is never portable Memory state', async () => {
    const stackHome = await temp();
    const oldVendorKey = 'C--Users-NT-Desktop-swft';
    const oldDir = await temp();
    const firstDir = await temp();
    const secondDir = await temp();
    await runMemoryBackup({
      stackHome,
      items: [await projectItem(oldVendorKey, oldDir, 'feedback content')],
    });

    // Rebind the SAME Project from one directory to another — pure machine-local state.
    let registry = await reconciledRegistry(oldVendorKey, firstDir);
    registry = setBinding(registry, {
      projectId: registry.projects[0]?.projectId as string,
      dir: path.resolve(secondDir),
      boundAt: '2026-10-20T00:01:00.000Z',
      provenance: 'user-map',
    });
    const secondVendorKey = encodeClaudeProjectKey(path.resolve(secondDir));
    const status = await computeMemoryWorkingTreeStatus({
      stackHome,
      nativeItems: [await projectItem(secondVendorKey, secondDir, 'feedback content')],
      registry,
    });
    expect(status).toEqual({ state: 'clean' });
  });

  it('unrelated Projects with the same filename/hash are never merged (no registry relationship between them)', async () => {
    const stackHome = await temp();
    const oneDir = await temp();
    const twoDir = await temp();
    await runMemoryBackup({
      stackHome,
      items: [await projectItem('C--project-one', oneDir, 'shared content')],
    });

    const status = await computeMemoryWorkingTreeStatus({
      stackHome,
      nativeItems: [await projectItem('C--project-two', twoDir, 'shared content')],
      registry: emptyRegistry(),
    });
    // Different, unrelated local identities with no registry relationship: the staged
    // Project's item is simply missing from this native scan (fine — unavailable project),
    // and the native Project's item has no staged counterpart — a real, surfaced change.
    expect(status).toEqual({ state: 'changes-not-added', changed: 1 });
  });
});
