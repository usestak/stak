import { describe, expect, it } from 'vitest';
import type { CanonicalDoc } from './domain.js';
import { planSync, type NativeEntry } from './sync.js';

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
const native = (path: string, n: number): NativeEntry => ({ path, contentHash: h(n) });

describe('planSync', () => {
  it('N=P=C: nothing changed -> no action', () => {
    const actions = planSync({
      native: [native('notes/a.md', 1)],
      projection: { 'notes/a.md': h(1) },
      canonical: [present('notes/a.md', 1)],
    });
    expect(actions).toEqual([{ kind: 'none' }]);
  });

  it('N != P, C = P: a native edit -> import-edit', () => {
    const actions = planSync({
      native: [native('notes/a.md', 2)],
      projection: { 'notes/a.md': h(1) },
      canonical: [present('notes/a.md', 1)],
    });
    expect(actions).toEqual([
      { kind: 'import-edit', path: 'notes/a.md', contentHash: h(2) },
    ]);
  });

  it('N = P, C != P: canonical moved ahead -> materialize-write', () => {
    const actions = planSync({
      native: [native('notes/a.md', 1)],
      projection: { 'notes/a.md': h(1) },
      canonical: [present('notes/a.md', 2)],
    });
    expect(actions).toEqual([
      { kind: 'materialize-write', path: 'notes/a.md', contentHash: h(2) },
    ]);
  });

  it('N != P, C != P, N = C: both reached the same result -> already-synced', () => {
    const actions = planSync({
      native: [native('notes/a.md', 2)],
      projection: { 'notes/a.md': h(1) },
      canonical: [present('notes/a.md', 2)],
    });
    expect(actions).toEqual([
      { kind: 'already-synced', path: 'notes/a.md', contentHash: h(2) },
    ]);
  });

  it('N != P, C != P, N != C: a real conflict (edit-edit)', () => {
    const actions = planSync({
      native: [native('notes/a.md', 2)],
      projection: { 'notes/a.md': h(1) },
      canonical: [present('notes/a.md', 3)],
    });
    expect(actions).toEqual([
      { kind: 'conflict', path: 'notes/a.md', reason: 'edit-edit' },
    ]);
  });

  it('native missing, P present, C unchanged -> import-delete', () => {
    const actions = planSync({
      native: [],
      projection: { 'notes/a.md': h(1) },
      canonical: [present('notes/a.md', 1)],
    });
    expect(actions).toEqual([{ kind: 'import-delete', path: 'notes/a.md' }]);
  });

  it('canonical deleted, native unchanged (N=P) -> materialize-delete', () => {
    const actions = planSync({
      native: [native('notes/a.md', 1)],
      projection: { 'notes/a.md': h(1) },
      canonical: [deleted('notes/a.md', 1)],
    });
    expect(actions).toEqual([{ kind: 'materialize-delete', path: 'notes/a.md' }]);
  });

  // Spec §7: "STAK never treats a missing entry as a deletion." Only a
  // tombstone deletes a native file; a canonical document that is simply
  // ABSENT (e.g. Memory filed under an ID this pass did not fold) leaves the
  // native file alone. The stale projection entry is ignored, so the path is
  // treated as never synced: `stak add .` re-imports it, and materialize
  // writes nothing.
  it('canonical ABSENT, native unchanged (N=P) -> never materialize-delete; re-import on add', () => {
    const actions = planSync({
      native: [native('notes/a.md', 1)],
      projection: { 'notes/a.md': h(1) },
      canonical: [],
    });
    expect(actions).toEqual([{ kind: 'import-edit', path: 'notes/a.md', contentHash: h(1) }]);
  });

  it('canonical ABSENT, native gone too -> nothing', () => {
    const actions = planSync({ native: [], projection: { 'notes/a.md': h(1) }, canonical: [] });
    expect(actions).toEqual([{ kind: 'none' }]);
  });

  it('canonical deleted, native edited (N!=P) -> conflict edit-delete', () => {
    const actions = planSync({
      native: [native('notes/a.md', 2)],
      projection: { 'notes/a.md': h(1) },
      canonical: [deleted('notes/a.md', 1)],
    });
    expect(actions).toEqual([
      { kind: 'conflict', path: 'notes/a.md', reason: 'edit-delete' },
    ]);
  });

  it('native deleted (missing), canonical edited after P -> conflict delete-edit', () => {
    const actions = planSync({
      native: [],
      projection: { 'notes/a.md': h(1) },
      canonical: [present('notes/a.md', 2)],
    });
    expect(actions).toEqual([
      { kind: 'conflict', path: 'notes/a.md', reason: 'delete-edit' },
    ]);
  });

  it('first sighting (no P), native and canonical identical -> already-synced', () => {
    const actions = planSync({
      native: [native('notes/a.md', 1)],
      projection: {},
      canonical: [present('notes/a.md', 1)],
    });
    expect(actions).toEqual([
      { kind: 'already-synced', path: 'notes/a.md', contentHash: h(1) },
    ]);
  });

  it('first sighting (no P), native and canonical differ -> conflict adopt-mismatch', () => {
    const actions = planSync({
      native: [native('notes/a.md', 1)],
      projection: {},
      canonical: [present('notes/a.md', 2)],
    });
    expect(actions).toEqual([
      { kind: 'conflict', path: 'notes/a.md', reason: 'adopt-mismatch' },
    ]);
  });

  it('a brand-new native file with no P and no C -> import-edit', () => {
    const actions = planSync({
      native: [native('notes/new.md', 1)],
      projection: {},
      canonical: [],
    });
    expect(actions).toEqual([
      { kind: 'import-edit', path: 'notes/new.md', contentHash: h(1) },
    ]);
  });

  it('a tombstoned path with no native and no P stays none (already deleted both sides)', () => {
    const actions = planSync({
      native: [],
      projection: {},
      canonical: [deleted('notes/gone.md', 1)],
    });
    expect(actions).toEqual([{ kind: 'none' }]);
  });

  it('tombstone-resurrection guard: a native file byte-identical to a tombstone is never re-imported', () => {
    const actions = planSync({
      native: [native('notes/gone.md', 1)],
      projection: {},
      canonical: [deleted('notes/gone.md', 1)],
    });
    // Not import-edit. The native copy matches what was deleted, so it is ignored.
    expect(actions).toEqual([{ kind: 'none' }]);
  });

  it('tombstone-resurrection guard does not block genuinely new content at the same path', () => {
    const actions = planSync({
      native: [native('notes/gone.md', 2)],
      projection: {},
      canonical: [deleted('notes/gone.md', 1)],
    });
    expect(actions).toEqual([
      { kind: 'import-edit', path: 'notes/gone.md', contentHash: h(2) },
    ]);
  });
});
