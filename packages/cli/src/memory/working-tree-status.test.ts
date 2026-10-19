import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashBytes, runMemoryBackup, type DiscoveredMemoryItem } from '@stack/memory';

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
