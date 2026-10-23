import { describe, expect, it } from 'vitest';
import { CANONICAL_MAIN_SCHEMA_VERSION, type CanonicalDoc, type CanonicalMainManifest } from './domain.js';
import { keepBothPath, mergeCanonical, resolveConflictDocs } from './merge.js';

const h = (n: number) => `sha256:${n.toString().padStart(64, '0')}`;
const present = (path: string, n: number): CanonicalDoc => ({
  path,
  state: 'present',
  contentHash: h(n),
  importedFrom: 'claude',
  importedAt: '2026-10-22T00:00:00.000Z',
});
const deleted = (path: string, n: number): CanonicalDoc => ({
  path,
  state: 'deleted',
  lastContentHash: h(n),
  deletedAt: '2026-10-22T00:00:00.000Z',
});
const manifest = (docs: CanonicalDoc[]): CanonicalMainManifest => ({
  schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
  projects: [{ projectId: 'prj_x', documents: docs }],
});

describe('mergeCanonical', () => {
  it('merge(B,B,R) = R: only remote changed', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 1)]);
    const remote = manifest([present('notes/a.md', 2)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.projects[0]!.documents).toEqual([present('notes/a.md', 2)]);
  });

  it('merge(B,L,B) = L: only local changed', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 2)]);
    const remote = manifest([present('notes/a.md', 1)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.projects[0]!.documents).toEqual([present('notes/a.md', 2)]);
  });

  it('merge(B,X,X) = X: identical changes on both sides agree, no conflict', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 2)]);
    const remote = manifest([present('notes/a.md', 2)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.projects[0]!.documents).toEqual([present('notes/a.md', 2)]);
  });

  it('identical deletes on both sides agree, no conflict', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([deleted('notes/a.md', 1)]);
    const remote = manifest([deleted('notes/a.md', 1)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.projects[0]!.documents).toEqual([deleted('notes/a.md', 1)]);
  });

  it('different edits on both sides conflict and are excluded from the merge result', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 2)]);
    const remote = manifest([present('notes/a.md', 3)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([{ projectId: 'prj_x', path: 'notes/a.md', reason: 'edit-edit' }]);
    expect(merged.projects[0]!.documents).toEqual([]);
  });

  it('edit on one side, delete on the other conflicts', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 2)]);
    const remote = manifest([deleted('notes/a.md', 1)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([{ projectId: 'prj_x', path: 'notes/a.md', reason: 'edit-delete' }]);
    expect(merged.projects[0]!.documents).toEqual([]);
  });

  it('a brand-new document added only on one side is carried over with no conflict', () => {
    const base = manifest([]);
    const local = manifest([present('notes/new.md', 1)]);
    const remote = manifest([]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.projects[0]!.documents).toEqual([present('notes/new.md', 1)]);
  });

  it('a project absent from base/local but present in remote is carried over', () => {
    const base: CanonicalMainManifest = { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [] };
    const local: CanonicalMainManifest = { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [] };
    const remote = manifest([present('notes/a.md', 1)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.projects.find((p) => p.projectId === 'prj_x')?.documents).toEqual([
      present('notes/a.md', 1),
    ]);
  });

  it('delete-vs-delete with different lastContentHash conflicts as delete-delete', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([deleted('notes/a.md', 1)]);
    const remote = manifest([deleted('notes/a.md', 2)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([{ projectId: 'prj_x', path: 'notes/a.md', reason: 'delete-delete' }]);
    expect(merged.projects[0]!.documents).toEqual([]);
  });

  it('one side absent (no entry), other side present conflicts as edit-delete', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local: CanonicalMainManifest = { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [{ projectId: 'prj_x', documents: [] }] };
    const remote = manifest([present('notes/a.md', 2)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([{ projectId: 'prj_x', path: 'notes/a.md', reason: 'edit-delete' }]);
    expect(merged.projects[0]!.documents).toEqual([]);
  });
});

describe('keepBothPath', () => {
  it('builds <stem>.conflict-<12-hex>.<ext> from the local content hash', () => {
    const hash = `sha256:${'a'.repeat(64)}`;
    expect(keepBothPath('notes/auth.md', hash, () => false)).toBe(
      'notes/auth.conflict-aaaaaaaaaaaa.md',
    );
  });

  it('is deterministic for the same path and hash', () => {
    const hash = `sha256:${'b'.repeat(64)}`;
    const a = keepBothPath('notes/x.md', hash, () => false);
    const b = keepBothPath('notes/x.md', hash, () => false);
    expect(a).toBe(b);
  });

  it('extends to 16 hex characters, then the full hash, on collision', () => {
    const hash = `sha256:${'c'.repeat(64)}`;
    const twelve = 'notes/x.conflict-cccccccccccc.md';
    const sixteen = 'notes/x.conflict-cccccccccccccccc.md';
    const full = `notes/x.conflict-${'c'.repeat(64)}.md`;
    const isTaken = (candidate: string) => candidate === twelve || candidate === sixteen;
    expect(keepBothPath('notes/x.md', hash, isTaken)).toBe(full);
  });

  it('handles a path with no extension', () => {
    const hash = `sha256:${'d'.repeat(64)}`;
    expect(keepBothPath('notes/README', hash, () => false)).toBe(
      'notes/README.conflict-dddddddddddd',
    );
  });
});

describe('resolveConflictDocs (Task 14)', () => {
  const at = '2026-10-23T00:00:00.000Z';
  const P = 'notes/a.md';
  const never = () => false;
  const alt = (n: number) => `notes/a.conflict-${h(n).slice('sha256:'.length, 'sha256:'.length + 12)}.md`;
  const tomb = (n: number): CanonicalDoc => ({ path: P, state: 'deleted', lastContentHash: h(n), deletedAt: at });

  it('edit-edit: each side, and both = Cloud at the path + local at the keep-both path', () => {
    expect(resolveConflictDocs('local', P, present(P, 2), present(P, 3), at, never)).toEqual({ primary: present(P, 2) });
    expect(resolveConflictDocs('cloud', P, present(P, 2), present(P, 3), at, never)).toEqual({ primary: present(P, 3) });
    expect(resolveConflictDocs('both', P, present(P, 2), present(P, 3), at, never)).toEqual({
      primary: present(P, 3),
      alt: present(alt(2), 2),
    });
  });

  it('local present, Cloud tombstone: both keeps the tombstone at the path and local at the keep-both path', () => {
    expect(resolveConflictDocs('local', P, present(P, 2), deleted(P, 1), at, never)).toEqual({ primary: present(P, 2) });
    expect(resolveConflictDocs('cloud', P, present(P, 2), deleted(P, 1), at, never)).toEqual({ primary: deleted(P, 1) });
    expect(resolveConflictDocs('both', P, present(P, 2), deleted(P, 1), at, never)).toEqual({
      primary: deleted(P, 1),
      alt: present(alt(2), 2),
    });
  });

  it("local present, Cloud absent: cloud/both = a tombstone of local's content at the path; both also keeps local aside", () => {
    expect(resolveConflictDocs('local', P, present(P, 2), undefined, at, never)).toEqual({ primary: present(P, 2) });
    expect(resolveConflictDocs('cloud', P, present(P, 2), undefined, at, never)).toEqual({ primary: tomb(2) });
    expect(resolveConflictDocs('both', P, present(P, 2), undefined, at, never)).toEqual({
      primary: tomb(2),
      alt: present(alt(2), 2),
    });
  });

  it("local tombstone or absent, Cloud present: local = the deletion (a tombstone of Cloud's content when absent); both = Cloud only", () => {
    expect(resolveConflictDocs('local', P, deleted(P, 1), present(P, 3), at, never)).toEqual({ primary: deleted(P, 1) });
    expect(resolveConflictDocs('local', P, undefined, present(P, 3), at, never)).toEqual({ primary: tomb(3) });
    for (const local of [deleted(P, 1), undefined]) {
      expect(resolveConflictDocs('cloud', P, local, present(P, 3), at, never)).toEqual({ primary: present(P, 3) });
      expect(resolveConflictDocs('both', P, local, present(P, 3), at, never)).toEqual({ primary: present(P, 3) });
    }
  });

  it("delete-delete: each side keeps its own tombstone; both = Cloud's deletion", () => {
    expect(resolveConflictDocs('local', P, deleted(P, 2), deleted(P, 3), at, never)).toEqual({ primary: deleted(P, 2) });
    expect(resolveConflictDocs('cloud', P, deleted(P, 2), deleted(P, 3), at, never)).toEqual({ primary: deleted(P, 3) });
    expect(resolveConflictDocs('both', P, deleted(P, 2), deleted(P, 3), at, never)).toEqual({ primary: deleted(P, 3) });
    expect(resolveConflictDocs('cloud', P, deleted(P, 2), undefined, at, never)).toEqual({ primary: deleted(P, 2) });
    expect(resolveConflictDocs('local', P, undefined, deleted(P, 3), at, never)).toEqual({ primary: deleted(P, 3) });
  });

  it('keep-both extends the name on collision', () => {
    const short = alt(2);
    const result = resolveConflictDocs('both', P, present(P, 2), present(P, 3), at, (c) => c === short);
    expect(result.alt?.path).toBe(`notes/a.conflict-${h(2).slice('sha256:'.length, 'sha256:'.length + 16)}.md`);
  });

  it('neither side present at all is an error, never a guess', () => {
    expect(() => resolveConflictDocs('local', P, undefined, undefined, at, never)).toThrow(/nothing to resolve/);
  });
});
