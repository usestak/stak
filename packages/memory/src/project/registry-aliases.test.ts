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
