import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CANONICAL_MAIN_SCHEMA_VERSION,
  type CanonicalDoc,
  type CanonicalMainManifest,
} from './domain.js';
import { foldStoredCanonicalState } from './fold-store.js';
import {
  canonicalStorePaths,
  readCanonicalBase,
  readCanonicalMain,
  readProjection,
  writeCanonicalBase,
  writeCanonicalMain,
  writePendingMerge,
  writeProjection,
} from './store.js';

const X = 'prj_xxxxxxxxxxxxxxxxxxxxxxxxxx';
const Y = 'prj_yyyyyyyyyyyyyyyyyyyyyyyyyy';
const aliasOf = (id: string) => (id === X ? Y : id);
const doc: CanonicalDoc = {
  path: 'notes/a.md',
  state: 'present',
  contentHash: `sha256:${'1'.repeat(64)}`,
  importedFrom: 'claude',
  importedAt: '2026-10-26T00:00:00.000Z',
};
const mainOf = (projectId: string): CanonicalMainManifest => ({
  schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
  projects: [{ projectId, documents: [doc] }],
});

let stackHome: string;
beforeEach(async () => {
  stackHome = await mkdtemp(path.join(tmpdir(), 'stak-fold-store-'));
  await writeCanonicalMain(stackHome, mainOf(X));
  await writeCanonicalBase(stackHome, {
    generation: 1,
    main: mainOf(X),
    globalDigest: 'g',
  });
  await writeProjection(stackHome, 'claude', {
    schemaVersion: 1,
    projects: { [X]: { 'notes/a.md': doc.contentHash } },
  });
  await writePendingMerge(stackHome, {
    basedOnGeneration: 2,
    merged: mainOf(X),
    conflicts: [{ projectId: X, path: 'notes/b.md', reason: 'edit-edit' }],
  });
});
afterEach(async () => rm(stackHome, { recursive: true, force: true }));

describe('foldStoredCanonicalState (spec §4.2.1)', () => {
  it('without persist, folds in memory and writes nothing', async () => {
    const before = await readFile(canonicalStorePaths(stackHome).main, 'utf8');
    const result = await foldStoredCanonicalState(stackHome, aliasOf, {
      persist: false,
    });
    expect(result.changed).toBe(true);
    expect(result.main).toEqual(mainOf(Y));
    expect(result.projection.projects).toEqual({
      [Y]: { 'notes/a.md': doc.contentHash },
    });
    expect(await readFile(canonicalStorePaths(stackHome).main, 'utf8')).toBe(
      before,
    );
  });

  it('with persist, folds main, base, the pending merge and the projection once, and is then a no-op', async () => {
    const result = await foldStoredCanonicalState(stackHome, aliasOf, {
      persist: true,
    });
    expect(result.report.merged).toEqual([
      { fromProjectId: X, toProjectId: Y },
    ]);
    expect(await readCanonicalMain(stackHome)).toEqual(mainOf(Y));
    expect(await readCanonicalBase(stackHome)).toEqual({
      generation: 1,
      main: mainOf(Y),
      globalDigest: 'g',
    });
    expect((await readProjection(stackHome, 'claude')).projects).toEqual({
      [Y]: { 'notes/a.md': doc.contentHash },
    });
    const pending = JSON.parse(
      await readFile(canonicalStorePaths(stackHome).merge, 'utf8'),
    ) as {
      merged: CanonicalMainManifest;
      conflicts: { projectId: string }[];
    };
    expect(pending.merged).toEqual(mainOf(Y));
    expect(pending.conflicts.map((c) => c.projectId)).toEqual([Y]);

    const again = await foldStoredCanonicalState(stackHome, aliasOf, {
      persist: true,
    });
    expect(again.changed).toBe(false);
    expect(again.report).toEqual({ merged: [], keptBoth: [] });
  });
});
