import { describe, expect, it } from 'vitest';

import { CANONICAL_MAIN_SCHEMA_VERSION, type CanonicalDoc, type CanonicalMainManifest } from './domain.js';
import { keepBothPath } from './merge.js';
import { foldPendingMerge, foldProjectAliases, foldProjection } from './project-fold.js';

// Spec §4.2.1: folding Memory filed under a former Project ID into the
// surviving one.
const X = 'prj_xxxxxxxxxxxxxxxxxxxxxxxxxx';
const Y = 'prj_yyyyyyyyyyyyyyyyyyyyyyyyyy';
const Z = 'prj_zzzzzzzzzzzzzzzzzzzzzzzzzz';
const OTHER = 'prj_pppppppppppppppppppppppppp';

const h = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const present = (path: string, n: number, importedAt = '2026-10-26T00:00:00.000Z'): CanonicalDoc => ({
  path,
  state: 'present',
  contentHash: h(n),
  importedFrom: 'claude',
  importedAt,
});
const deleted = (path: string, n: number): CanonicalDoc => ({
  path,
  state: 'deleted',
  lastContentHash: h(n),
  deletedAt: '2026-10-26T00:00:00.000Z',
});
const main = (projects: Record<string, CanonicalDoc[]>): CanonicalMainManifest => ({
  schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
  projects: Object.entries(projects).map(([projectId, documents]) => ({ projectId, documents })),
});
const docsOf = (m: CanonicalMainManifest, projectId: string) =>
  m.projects.find((p) => p.projectId === projectId)?.documents;
const aliasXtoY = (id: string) => (id === X ? Y : id);

describe('foldProjectAliases', () => {
  it('moves a document only the former ID has to the surviving ID at the same path', () => {
    const { main: folded, report } = foldProjectAliases(main({ [X]: [present('notes/a.md', 1)] }), aliasXtoY);
    expect(folded.projects.map((p) => p.projectId)).toEqual([Y]);
    expect(docsOf(folded, Y)).toEqual([present('notes/a.md', 1)]);
    expect(report).toEqual({ merged: [{ fromProjectId: X, toProjectId: Y }], keptBoth: [] });
  });

  it('the same path with the same content becomes one document (the surviving one)', () => {
    const { main: folded, report } = foldProjectAliases(
      main({ [X]: [present('notes/a.md', 1, '2026-01-01T00:00:00.000Z')], [Y]: [present('notes/a.md', 1)] }),
      aliasXtoY,
    );
    expect(docsOf(folded, Y)).toEqual([present('notes/a.md', 1)]);
    expect(docsOf(folded, X)).toBeUndefined();
    expect(report.keptBoth).toEqual([]);
  });

  it('the same path with different content keeps the surviving version at the path and the former one at the keep-both path', () => {
    const { main: folded, report } = foldProjectAliases(
      main({ [X]: [present('notes/a.md', 1)], [Y]: [present('notes/a.md', 2)] }),
      aliasXtoY,
    );
    const alt = keepBothPath('notes/a.md', h(1), () => false);
    expect(alt).toBe(`notes/a.conflict-${h(1).slice(7, 19)}.md`);
    expect(docsOf(folded, Y)).toEqual([present(alt, 1), present('notes/a.md', 2)]);
    expect(report.keptBoth).toEqual([{ projectId: Y, path: 'notes/a.md', keptAt: alt, fromProjectId: X }]);
  });

  it("keep-both uses keepBothPath's collision rule when the short name already holds other content", () => {
    const short = keepBothPath('notes/a.md', h(1), () => false);
    const { main: folded } = foldProjectAliases(
      main({ [X]: [present('notes/a.md', 1)], [Y]: [present('notes/a.md', 2), present(short, 3)] }),
      aliasXtoY,
    );
    const long = keepBothPath('notes/a.md', h(1), (c) => c === short);
    expect(long).not.toBe(short);
    expect(docsOf(folded, Y)?.find((d) => d.path === long)).toEqual(present(long, 1));
    expect(docsOf(folded, Y)?.find((d) => d.path === short)).toEqual(present(short, 3));
  });

  it('a present document beats a deletion of the same path, on either side', () => {
    const formerPresent = foldProjectAliases(
      main({ [X]: [present('notes/a.md', 1)], [Y]: [deleted('notes/a.md', 9)] }),
      aliasXtoY,
    ).main;
    expect(docsOf(formerPresent, Y)).toEqual([present('notes/a.md', 1)]);
    const survivingPresent = foldProjectAliases(
      main({ [X]: [deleted('notes/a.md', 9)], [Y]: [present('notes/a.md', 2)] }),
      aliasXtoY,
    ).main;
    expect(docsOf(survivingPresent, Y)).toEqual([present('notes/a.md', 2)]);
  });

  it('a deletion only the former ID has moves too; two deletions keep the surviving one', () => {
    const moved = foldProjectAliases(main({ [X]: [deleted('notes/a.md', 1)] }), aliasXtoY).main;
    expect(docsOf(moved, Y)).toEqual([deleted('notes/a.md', 1)]);
    const both = foldProjectAliases(
      main({ [X]: [deleted('notes/a.md', 1)], [Y]: [deleted('notes/a.md', 2)] }),
      aliasXtoY,
    ).main;
    expect(docsOf(both, Y)).toEqual([deleted('notes/a.md', 2)]);
  });

  it('chains resolve: A became B and B became C ends up entirely under C', () => {
    const alias = (id: string) => (id === X || id === Y ? Z : id);
    const { main: folded, report } = foldProjectAliases(
      main({ [X]: [present('notes/x.md', 1)], [Y]: [present('notes/y.md', 2)], [Z]: [present('notes/z.md', 3)] }),
      alias,
    );
    expect(folded.projects.map((p) => p.projectId)).toEqual([Z]);
    expect(docsOf(folded, Z)?.map((d) => d.path)).toEqual(['notes/x.md', 'notes/y.md', 'notes/z.md']);
    expect(report.merged).toEqual([
      { fromProjectId: X, toProjectId: Z },
      { fromProjectId: Y, toProjectId: Z },
    ]);
  });

  it('is deterministic (input order does not matter) and idempotent', () => {
    const a = main({ [X]: [present('notes/a.md', 1), present('notes/b.md', 4)], [Y]: [present('notes/a.md', 2)] });
    const b: CanonicalMainManifest = {
      ...a,
      projects: [...a.projects].reverse().map((p) => ({ ...p, documents: [...p.documents].reverse() })),
    };
    const once = foldProjectAliases(a, aliasXtoY).main;
    expect(foldProjectAliases(b, aliasXtoY).main).toEqual(once);
    const twice = foldProjectAliases(once, aliasXtoY);
    expect(twice.main).toEqual(once);
    expect(twice.report).toEqual({ merged: [], keptBoth: [] });
  });

  it('leaves projects whose ID is not an alias untouched, and returns the same manifest when nothing folds', () => {
    const input = main({ [OTHER]: [present('notes/o.md', 5)], [X]: [present('notes/a.md', 1)] });
    const { main: folded } = foldProjectAliases(input, aliasXtoY);
    expect(folded.projects.find((p) => p.projectId === OTHER)).toBe(input.projects[0]);
    const untouched = main({ [OTHER]: [present('notes/o.md', 5)] });
    expect(foldProjectAliases(untouched, aliasXtoY).main).toBe(untouched);
  });
});

describe('foldProjection', () => {
  it("moves the former ID's entries to the surviving ID, keeping the surviving entry for a shared path", () => {
    const { projection, changed } = foldProjection(
      {
        schemaVersion: 1,
        projects: { [X]: { 'notes/a.md': h(1), 'notes/b.md': h(2) }, [Y]: { 'notes/a.md': h(3) }, [OTHER]: { 'notes/o.md': h(5) } },
      },
      aliasXtoY,
    );
    expect(changed).toBe(true);
    expect(projection.projects).toEqual({
      [Y]: { 'notes/a.md': h(3), 'notes/b.md': h(2) },
      [OTHER]: { 'notes/o.md': h(5) },
    });
  });
});

describe('foldPendingMerge', () => {
  it('folds the merged manifest, the conflict list and the resolved entries', () => {
    const { pending, changed } = foldPendingMerge(
      {
        basedOnGeneration: 3,
        merged: main({ [X]: [present('notes/b.md', 2)] }),
        conflicts: [{ projectId: X, path: 'notes/a.md', reason: 'edit-edit' }],
        resolved: [{ projectId: X, path: 'notes/c.md', keep: 'local', local: null }],
      },
      aliasXtoY,
    );
    expect(changed).toBe(true);
    expect(pending.merged.projects.map((p) => p.projectId)).toEqual([Y]);
    expect(pending.conflicts).toEqual([{ projectId: Y, path: 'notes/a.md', reason: 'edit-edit' }]);
    expect(pending.resolved).toEqual([{ projectId: Y, path: 'notes/c.md', keep: 'local', local: null }]);
  });
});
