import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readMemoryStatus } from './adapter.js';
import { CANONICAL_MAIN_SCHEMA_VERSION } from './canonical/domain.js';
import { writeCanonicalMain } from './canonical/store.js';
import { hashBytes, writeMemoryManifest } from './store.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-memstatus-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const hash = (body: string) => hashBytes(Buffer.from(body, 'utf8'));
const pid = (c: string) => `prj_${c.repeat(26)}`;
const present = (p: string, body: string) => ({
  path: p,
  state: 'present' as const,
  contentHash: hash(body),
  importedFrom: 'claude' as const,
  importedAt: '2026-10-26T00:00:00.000Z',
});
const deleted = (p: string, body: string) => ({
  path: p,
  state: 'deleted' as const,
  lastContentHash: hash(body),
  deletedAt: '2026-10-26T00:00:00.000Z',
});

describe('readMemoryStatus counts canonical Project Memory (two-machine Bug B)', () => {
  it('counts projects with present documents and present documents, plus global items', async () => {
    const stackHome = await temp();
    // Since the canonical migration the v1 manifest is global-only.
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-26T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'user-instructions',
            scope: 'global',
            logicalId: 'claude/user-instructions/CLAUDE.md',
            contentHash: hash('global'),
            restoreTarget: { base: 'claude-home', relativePath: 'CLAUDE.md' },
            capturedAt: '2026-10-26T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    await writeCanonicalMain(stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        {
          projectId: pid('a'),
          documents: [
            present('notes/MEMORY.md', 'a1'),
            present('notes/b.md', 'a2'),
            deleted('notes/old.md', 'x'),
          ],
        },
        {
          projectId: pid('b'),
          documents: [present('instructions/private.md', 'b1')],
        },
        // Only tombstones: nothing is backed up for this project any more.
        { projectId: pid('c'), documents: [deleted('notes/gone.md', 'c1')] },
      ],
    });
    expect(await readMemoryStatus(stackHome)).toEqual({
      provider: 'claude',
      projects: 2,
      files: 4,
      lastBackupAt: '2026-10-26T00:00:00.000Z',
    });
  });

  it('reports canonical Project Memory even with no v1 manifest', async () => {
    const stackHome = await temp();
    await writeCanonicalMain(stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        { projectId: pid('a'), documents: [present('notes/MEMORY.md', 'a1')] },
      ],
    });
    expect(await readMemoryStatus(stackHome)).toMatchObject({
      projects: 1,
      files: 1,
      lastBackupAt: null,
    });
  });

  it('still returns null when nothing is backed up at all', async () => {
    expect(await readMemoryStatus(await temp())).toBeNull();
  });
});
