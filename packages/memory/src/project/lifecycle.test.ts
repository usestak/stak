import { describe, expect, it } from 'vitest';

import type { ProjectIdentity } from '../domain.js';
import {
  emptyRegistry,
  lifecycleOf,
  localRegistrySchema,
  mergePortableSnapshot,
  portableRegistrySnapshotSchema,
  resolveOrMintProject,
  setLifecycle,
  toPortableSnapshot,
  type LocalRegistry,
  type PortableProjectRecord,
} from './registry.js';

const A = '0123456789abcdefghjkmnpqrstvwxyz';
const pid = (n: number) => `prj_${(A[n] as string).repeat(26)}`;
const git = (canonical: string): ProjectIdentity => ({
  kind: 'git',
  canonical,
  host: canonical.split('/')[0] as string,
  owner: canonical.split('/')[1] as string,
  repo: canonical.split('/')[2] as string,
});
let counter = 0;
const mint = () => pid(counter++);

const only = (records: PortableProjectRecord[]): PortableProjectRecord => {
  const record = records[0];
  if (!record) throw new Error('expected at least one project record');
  return record;
};

describe('project lifecycle model (15C)', () => {
  it('1. a legacy record without a lifecycle decodes as active', () => {
    const parsed = localRegistrySchema.parse({
      schemaVersion: 1,
      projects: [
        {
          projectId: pid(0),
          claims: [{ type: 'git', canonical: 'github.com/a/b' }],
        },
      ],
      bindings: [],
    });
    expect(only(parsed.projects).lifecycle).toBeUndefined();
    expect(lifecycleOf(only(parsed.projects))).toBe('active');
  });

  it('2. a freshly minted project + its snapshot serialize lifecycle=active', () => {
    counter = 0;
    const { registry } = resolveOrMintProject(
      emptyRegistry(),
      git('github.com/a/b'),
      mint,
    );
    expect(only(registry.projects).lifecycle).toBe('active');
    const snapshot = toPortableSnapshot(registry);
    expect(only(snapshot.projects).lifecycle).toBe('active');
    expect(
      only(portableRegistrySnapshotSchema.parse(snapshot).projects).lifecycle,
    ).toBe('active');
  });

  it('3-6. archive/unarchive are set operations and idempotent', () => {
    counter = 0;
    const base = resolveOrMintProject(
      emptyRegistry(),
      git('github.com/a/b'),
      mint,
    ).registry;
    const id = only(base.projects).projectId;

    const archived = setLifecycle(base, id, 'archived');
    expect(lifecycleOf(only(archived.projects))).toBe('archived');
    const archivedAgain = setLifecycle(archived, id, 'archived');
    expect(lifecycleOf(only(archivedAgain.projects))).toBe('archived');
    expect(archivedAgain.projects).toHaveLength(1);

    const active = setLifecycle(archived, id, 'active');
    expect(lifecycleOf(only(active.projects))).toBe('active');
    const activeAgain = setLifecycle(active, id, 'active');
    expect(lifecycleOf(only(activeAgain.projects))).toBe('active');
    expect(activeAgain.projects).toHaveLength(1);
  });

  it('8-11. archive preserves Project ID and identity claims (no new/duplicate records)', () => {
    counter = 0;
    let reg = resolveOrMintProject(
      emptyRegistry(),
      git('github.com/a/b'),
      mint,
    ).registry;
    const before = only(reg.projects);
    reg = setLifecycle(reg, before.projectId, 'archived');
    const after = only(reg.projects);
    expect(reg.projects).toHaveLength(1);
    expect(after.projectId).toBe(before.projectId);
    expect(after.claims).toEqual(before.claims);
  });

  it('merge: a fresh registry adopts the snapshot’s lifecycle', () => {
    counter = 0;
    let source = resolveOrMintProject(
      emptyRegistry(),
      git('github.com/a/b'),
      mint,
    ).registry;
    const id = only(source.projects).projectId;
    source = setLifecycle(source, id, 'archived');
    const merged = mergePortableSnapshot(
      emptyRegistry(),
      toPortableSnapshot(source),
    );
    expect(merged.conflicts).toEqual([]);
    expect(lifecycleOf(only(merged.registry.projects))).toBe('archived');
    expect(only(merged.registry.projects).projectId).toBe(id);
  });

  it('merge: recovered lifecycle is authoritative over local (archived local, active backup → active)', () => {
    counter = 0;
    const source = resolveOrMintProject(
      emptyRegistry(),
      git('github.com/a/b'),
      mint,
    ).registry;
    const id = only(source.projects).projectId;
    const local: LocalRegistry = setLifecycle(source, id, 'archived');
    const incoming = toPortableSnapshot(setLifecycle(source, id, 'active'));
    const merged = mergePortableSnapshot(local, incoming);
    // Explicit recovery: the selected backup wins for portable lifecycle.
    expect(lifecycleOf(only(merged.registry.projects))).toBe('active');
    expect(only(merged.registry.projects).projectId).toBe(id);
  });

  it('merge: recovered lifecycle is authoritative over local (active local, archived backup → archived)', () => {
    counter = 0;
    const source = resolveOrMintProject(
      emptyRegistry(),
      git('github.com/a/b'),
      mint,
    ).registry;
    const id = only(source.projects).projectId;
    const local: LocalRegistry = setLifecycle(source, id, 'active');
    const incoming = toPortableSnapshot(setLifecycle(source, id, 'archived'));
    const merged = mergePortableSnapshot(local, incoming);
    expect(lifecycleOf(only(merged.registry.projects))).toBe('archived');
  });

  it('merge: a recovered pre-lifecycle record forces a locally-archived project back to active', () => {
    counter = 0;
    const source = resolveOrMintProject(
      emptyRegistry(),
      git('github.com/a/b'),
      mint,
    ).registry;
    const id = only(source.projects).projectId;
    const local: LocalRegistry = setLifecycle(source, id, 'archived');
    // Incoming snapshot with the lifecycle field stripped (pre-15C shape).
    const incoming = {
      snapshotVersion: 1 as const,
      projects: [{ projectId: id, claims: only(source.projects).claims }],
    };
    const merged = mergePortableSnapshot(local, incoming);
    expect(only(merged.registry.projects).lifecycle).toBeUndefined();
    expect(lifecycleOf(only(merged.registry.projects))).toBe('active');
  });

  it('merge: a recovered lifecycle change never disturbs a machine-local binding', () => {
    counter = 0;
    const source = resolveOrMintProject(
      emptyRegistry(),
      git('github.com/a/b'),
      mint,
    ).registry;
    const id = only(source.projects).projectId;
    const binding = {
      projectId: id,
      dir: '/local/work/b',
      boundAt: '2026-09-30T00:00:00.000Z',
      provenance: 'user-map' as const,
    };
    const local: LocalRegistry = {
      ...setLifecycle(source, id, 'active'),
      bindings: [binding],
    };
    const incoming = toPortableSnapshot(setLifecycle(source, id, 'archived'));
    const merged = mergePortableSnapshot(local, incoming);
    expect(lifecycleOf(only(merged.registry.projects))).toBe('archived');
    // The local binding is untouched by the portable lifecycle change.
    expect(merged.registry.bindings).toEqual([binding]);
  });
});
