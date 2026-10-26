import { describe, expect, it } from 'vitest';

import {
  adoptReconciledProjectId,
  composeBundleSnapshot,
  emptyRegistry,
  learnProjectAliases,
  localRegistrySchema,
  mergePortableSnapshot,
  portableRegistrySnapshotSchema,
  projectAliasMap,
  recordFor,
  resolveProjectAlias,
  setBinding,
  toPortableSnapshot,
  trustedAliasResolver,
  type LocalRegistry,
  type PortableRegistrySnapshot,
} from './registry.js';

// Spec §4.2.1: when two Project IDs turn out to be the same project, the
// surviving project's record lists its former IDs, and they travel in the
// portable snapshot.
const X = 'prj_xxxxxxxxxxxxxxxxxxxxxxxxxx';
const Y = 'prj_yyyyyyyyyyyyyyyyyyyyyyyyyy';
const Z = 'prj_zzzzzzzzzzzzzzzzzzzzzzzzzz';
const W = 'prj_wwwwwwwwwwwwwwwwwwwwwwwwww';
const gitClaim = { type: 'git' as const, canonical: 'github.com/acme/demo' };

const registryWith = (...projects: LocalRegistry['projects']): LocalRegistry => ({ ...emptyRegistry(), projects });

describe('formerIds (spec §4.2.1)', () => {
  it('older registry and snapshot files without formerIds still parse', () => {
    expect(() =>
      localRegistrySchema.parse({ schemaVersion: 1, projects: [{ projectId: X, claims: [gitClaim] }], bindings: [] }),
    ).not.toThrow();
    expect(() =>
      portableRegistrySnapshotSchema.parse({ snapshotVersion: 1, projects: [{ projectId: X, claims: [gitClaim] }] }),
    ).not.toThrow();
  });

  it('adoptReconciledProjectId records the former ID, and any former IDs it already had, on the surviving record', () => {
    const registry = registryWith(
      { projectId: X, claims: [gitClaim], lifecycle: 'active', formerIds: [W] },
      { projectId: Y, claims: [gitClaim], lifecycle: 'active' },
    );
    const adopted = adoptReconciledProjectId(registry, X, Y);
    expect(recordFor(adopted, X)).toBeUndefined();
    expect(recordFor(adopted, Y)?.formerIds).toEqual([W, X]);
  });

  it('adopting into an ID this machine never saw still records the alias', () => {
    const adopted = adoptReconciledProjectId(registryWith({ projectId: X, claims: [gitClaim] }), X, Y);
    expect(recordFor(adopted, Y)?.formerIds).toEqual([X]);
  });

  it('a snapshot round-trip carries formerIds', () => {
    const registry = adoptReconciledProjectId(registryWith({ projectId: X, claims: [gitClaim] }), X, Y);
    const snapshot = toPortableSnapshot(registry);
    expect(snapshot.projects.find((p) => p.projectId === Y)?.formerIds).toEqual([X]);
    const parsed = portableRegistrySnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));
    const merged = mergePortableSnapshot(emptyRegistry(), parsed).registry;
    expect(recordFor(merged, Y)?.formerIds).toEqual([X]);
  });

  it('a record with no former IDs serializes without the field (older readers see the same bytes)', () => {
    const snapshot = toPortableSnapshot(registryWith({ projectId: X, claims: [gitClaim] }));
    expect('formerIds' in snapshot.projects[0]!).toBe(false);
  });
});

describe('resolveProjectAlias', () => {
  it('maps a former ID to its surviving ID and leaves other IDs alone', () => {
    const registry = registryWith({ projectId: Y, claims: [gitClaim], formerIds: [X] });
    expect(resolveProjectAlias(registry, X)).toBe(Y);
    expect(resolveProjectAlias(registry, Y)).toBe(Y);
    expect(resolveProjectAlias(registry, Z)).toBe(Z);
  });

  it('follows chains: A became B and B became C resolves A to C', () => {
    const map = projectAliasMap(
      registryWith({ projectId: Y, claims: [gitClaim], formerIds: [X] }),
      { snapshotVersion: 1, projects: [{ projectId: Z, claims: [gitClaim], formerIds: [Y] }] } as PortableRegistrySnapshot,
    );
    expect(resolveProjectAlias(map, X)).toBe(Z);
    expect(resolveProjectAlias(map, Y)).toBe(Z);
  });

  it('is guarded against cycles and resolves them deterministically', () => {
    const map = projectAliasMap(
      registryWith({ projectId: Y, claims: [gitClaim], formerIds: [X] }),
      { snapshotVersion: 1, projects: [{ projectId: X, claims: [gitClaim], formerIds: [Y] }] } as PortableRegistrySnapshot,
    );
    expect(resolveProjectAlias(map, X)).toBe(resolveProjectAlias(map, Y));
    expect([X, Y]).toContain(resolveProjectAlias(map, X));
  });
});

describe('learning aliases from a snapshot', () => {
  const remote: PortableRegistrySnapshot = {
    snapshotVersion: 1,
    projects: [{ projectId: Y, claims: [gitClaim], lifecycle: 'active', formerIds: [X] }],
  };

  it('learnProjectAliases retires a local former-ID record into the surviving ID, keeping its binding', () => {
    const local = setBinding(registryWith({ projectId: X, claims: [gitClaim], lifecycle: 'active' }), {
      projectId: X,
      dir: '/work/demo',
      boundAt: '2026-10-26T00:00:00.000Z',
      provenance: 'user-map',
    });
    const learned = learnProjectAliases(local, remote);
    expect(learned.adopted).toEqual([{ fromProjectId: X, toProjectId: Y }]);
    expect(recordFor(learned.registry, X)).toBeUndefined();
    expect(recordFor(learned.registry, Y)?.formerIds).toEqual([X]);
    expect(learned.registry.bindings.map((b) => b.projectId)).toEqual([Y]);
  });

  it('learnProjectAliases imports nothing else from the snapshot', () => {
    const unrelated = registryWith({ projectId: Z, claims: [{ type: 'git', canonical: 'github.com/acme/other' }] });
    const learned = learnProjectAliases(unrelated, remote);
    expect(learned.adopted).toEqual([]);
    expect(learned.registry).toBe(unrelated);
  });

  it('mergePortableSnapshot honors former IDs instead of reporting the shared claim as a conflict', () => {
    const local = registryWith({ projectId: X, claims: [gitClaim], lifecycle: 'active' });
    const merged = mergePortableSnapshot(local, remote);
    expect(merged.conflicts).toEqual([]);
    expect(merged.registry.projects.map((p) => p.projectId)).toEqual([Y]);
    expect(recordFor(merged.registry, Y)?.formerIds).toEqual([X]);
  });

  it('mergePortableSnapshot skips a stale record of an ID this machine already knows is a former one', () => {
    const local = registryWith({ projectId: Y, claims: [gitClaim], lifecycle: 'active', formerIds: [X] });
    const merged = mergePortableSnapshot(local, {
      snapshotVersion: 1,
      projects: [{ projectId: X, claims: [gitClaim], lifecycle: 'active' }],
    });
    expect(merged.conflicts).toEqual([]);
    expect(merged.registry.projects.map((p) => p.projectId)).toEqual([Y]);
  });

  it('mergePortableSnapshot unions formerIds for the same Project ID', () => {
    const local = registryWith({ projectId: Y, claims: [gitClaim], lifecycle: 'active', formerIds: [W] });
    const merged = mergePortableSnapshot(local, remote).registry;
    expect(recordFor(merged, Y)?.formerIds).toEqual([W, X]);
  });

  it('composeBundleSnapshot unions formerIds from the remote record and never carries a former ID as a project', () => {
    const local = registryWith({ projectId: Y, claims: [gitClaim], lifecycle: 'active', formerIds: [W] });
    const { snapshot } = composeBundleSnapshot(
      local,
      {
        snapshotVersion: 1,
        projects: [
          { projectId: X, claims: [gitClaim], lifecycle: 'active' },
          { projectId: Y, claims: [gitClaim], lifecycle: 'active', formerIds: [X] },
        ],
      },
      [Y, X],
    );
    expect(snapshot.projects.map((p) => p.projectId)).toEqual([Y]);
    expect(snapshot.projects[0]?.formerIds).toEqual([W, X]);
  });
});

describe('review fixes: aliases are only trusted when the projects share a claim', () => {
  const other = { type: 'git' as const, canonical: 'github.com/acme/unrelated' };
  const L = 'prj_kkkkkkkkkkkkkkkkkkkkkkkkkk';
  const M = 'prj_mmmmmmmmmmmmmmmmmmmmmmmmmm';
  const forged: PortableRegistrySnapshot = {
    snapshotVersion: 1,
    projects: [{ projectId: M, claims: [gitClaim], lifecycle: 'active', formerIds: [L] }],
  };
  const bound = (id: string, dir: string) => ({
    projectId: id,
    dir,
    boundAt: '2026-10-26T00:00:00.000Z',
    provenance: 'user-map' as const,
  });
  const localL = (): LocalRegistry =>
    setBinding(registryWith({ projectId: L, claims: [other], lifecycle: 'active' }), bound(L, '/work/unrelated'));

  it('learnProjectAliases leaves an unrelated local project untouched (I1)', () => {
    const local = localL();
    const learned = learnProjectAliases(local, forged);
    expect(learned.adopted).toEqual([]);
    expect(learned.registry).toBe(local);
  });

  it('mergePortableSnapshot does not retire an unrelated local project (I1)', () => {
    const merged = mergePortableSnapshot(localL(), forged).registry;
    expect(recordFor(merged, L)?.claims).toEqual([other]);
    expect(merged.bindings.map((b) => b.projectId)).toEqual([L]);
  });

  it('trustedAliasResolver ignores the forged alias, so nothing of L is folded (I1)', () => {
    expect(trustedAliasResolver(localL(), forged)(L)).toBe(L);
    // ...while a genuine alias (a shared Git claim) is honored.
    const genuine = registryWith({ projectId: X, claims: [gitClaim], lifecycle: 'active' });
    const snapshot: PortableRegistrySnapshot = {
      snapshotVersion: 1,
      projects: [{ projectId: Y, claims: [gitClaim], formerIds: [X] }],
    };
    expect(trustedAliasResolver(genuine, snapshot)(X)).toBe(Y);
  });

  it('never retires a record whose binding points somewhere the surviving record does not bind (I1)', () => {
    let local = registryWith(
      { projectId: X, claims: [gitClaim], lifecycle: 'active' },
      { projectId: Y, claims: [gitClaim], lifecycle: 'active' },
    );
    local = setBinding(setBinding(local, bound(X, '/work/one')), bound(Y, '/work/two'));
    const learned = learnProjectAliases(local, {
      snapshotVersion: 1,
      projects: [{ projectId: Y, claims: [gitClaim], formerIds: [X] }],
    });
    expect(learned.adopted).toEqual([]);
    expect(learned.registry.bindings.map((b) => b.dir).sort()).toEqual(['/work/one', '/work/two']);
  });

  it('persists learned former IDs on the surviving record even without a local former record (I2)', () => {
    const local = registryWith({ projectId: Y, claims: [gitClaim], lifecycle: 'active' });
    const learned = learnProjectAliases(local, {
      snapshotVersion: 1,
      projects: [{ projectId: Y, claims: [gitClaim], formerIds: [X] }],
    });
    expect(learned.changed).toBe(true);
    expect(recordFor(learned.registry, Y)?.formerIds).toEqual([X]);
  });

  it('persists nothing from a same-ID record whose claims are disjoint (I2)', () => {
    const local = registryWith({ projectId: Y, claims: [other], lifecycle: 'active' });
    const learned = learnProjectAliases(local, {
      snapshotVersion: 1,
      projects: [{ projectId: Y, claims: [gitClaim], formerIds: [X] }],
    });
    expect(learned.changed).toBe(false);
    expect(learned.registry).toBe(local);
  });

  it('composeBundleSnapshot never publishes a record the fetched snapshot names as a former ID, and keeps formerIds (C1)', () => {
    // Local still holds X (not folded yet); the fetched snapshot says X became Y.
    const local = registryWith({ projectId: X, claims: [gitClaim], lifecycle: 'active' });
    const { snapshot } = composeBundleSnapshot(
      local,
      { snapshotVersion: 1, projects: [{ projectId: Y, claims: [gitClaim], lifecycle: 'active', formerIds: [X] }] },
      [Y],
    );
    expect(snapshot.projects.map((p) => p.projectId)).toEqual([Y]);
    expect(snapshot.projects[0]?.formerIds).toEqual([X]);
  });
});
