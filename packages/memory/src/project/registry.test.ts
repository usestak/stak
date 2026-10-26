import { describe, expect, it } from 'vitest';

import type { ProjectIdentity } from '../domain.js';
import {
  adoptReconciledProjectId,
  bindingFor,
  claimKey,
  composeBundleSnapshot,
  emptyRegistry,
  identityClaim,
  legacyCompatKey,
  mergePortableSnapshot,
  nameHintFor,
  nameHintIsExplicit,
  registryConflicts,
  resolveOrMintProject,
  resolveProjectForIdentity,
  setBinding,
  setExplicitNameHint,
  setNameHint,
  toPortableSnapshot,
  type LocalRegistry,
} from './registry.js';

const git = (canonical: string): ProjectIdentity => ({
  kind: 'git',
  canonical,
  host: canonical.split('/')[0] as string,
  owner: canonical.split('/')[1] as string,
  repo: canonical.split('/')[2] as string,
});
const local = (vendorKey: string): ProjectIdentity => ({
  kind: 'local',
  vendorKey,
});

let counter = 0;
const mint = () => `prj_${(counter++).toString(36).padStart(26, '0')}`;

describe('project registry (portable model)', () => {
  it('derives a stable, path-free compatibility key for legacy identities', () => {
    const key = legacyCompatKey('local:C--Users-NT-Desktop-nexus');
    expect(key).toBe(legacyCompatKey('local:C--Users-NT-Desktop-nexus'));
    expect(key.startsWith('compat:')).toBe(true);
    // The raw path is not present in the compatibility key.
    expect(key).not.toContain('Users');
    expect(key).not.toContain('nexus');
  });

  it('resolves-or-mints and is stable for the same identity', () => {
    counter = 0;
    let reg = emptyRegistry();
    const first = resolveOrMintProject(reg, git('github.com/acme/atlas'), mint);
    reg = first.registry;
    expect(first.minted).toBe(true);
    const again = resolveOrMintProject(reg, git('github.com/acme/atlas'), mint);
    expect(again.minted).toBe(false);
    expect(again.projectId).toBe(first.projectId);
  });

  it('mints Project IDs for legacy identities with no directory (lazy migration)', () => {
    counter = 0;
    let reg = emptyRegistry();
    const nexus = resolveOrMintProject(
      reg,
      local('C--Users-NT-Desktop-nexus'),
      mint,
    );
    reg = nexus.registry;
    expect(nexus.minted).toBe(true);
    // Resolvable again by the same legacy identity, purely from the compat key.
    const found = resolveProjectForIdentity(
      reg,
      local('C--Users-NT-Desktop-nexus'),
    );
    expect(found).toEqual({ status: 'resolved', projectId: nexus.projectId });
  });

  it('the portable snapshot carries claims but never a filesystem path', () => {
    counter = 0;
    let reg = emptyRegistry();
    reg = resolveOrMintProject(
      reg,
      git('github.com/acme/atlas'),
      mint,
    ).registry;
    reg = resolveOrMintProject(
      reg,
      local('C--Users-NT-Desktop-nexus'),
      mint,
    ).registry;
    const snapshot = toPortableSnapshot(reg);
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain('C--Users-NT-Desktop-nexus');
    expect(text).not.toContain('Users');
    expect(text).not.toContain('\\');
    expect(snapshot.projects).toHaveLength(2);
    // Every project keeps a claim (git canonical or opaque legacy-compat key).
    for (const record of snapshot.projects)
      expect(record.claims.length).toBeGreaterThan(0);
  });

  it('merges a recovered snapshot preserving Project IDs and unioning claims', () => {
    counter = 0;
    let source = emptyRegistry();
    source = resolveOrMintProject(
      source,
      git('github.com/acme/atlas'),
      mint,
    ).registry;
    const snapshot = toPortableSnapshot(source);

    const merged = mergePortableSnapshot(emptyRegistry(), snapshot);
    expect(merged.conflicts).toEqual([]);
    expect(merged.registry.projects.map((r) => r.projectId)).toEqual(
      source.projects.map((r) => r.projectId),
    );
  });

  it('flags a conflict when one strong identity is claimed by two Project IDs', () => {
    const a: LocalRegistry = {
      schemaVersion: 1,
      projects: [
        {
          projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
          claims: [{ type: 'git', canonical: 'github.com/acme/atlas' }],
        },
      ],
      bindings: [],
    };
    const snapshot = {
      snapshotVersion: 1 as const,
      projects: [
        {
          projectId: 'prj_bbbbbbbbbbbbbbbbbbbbbbbbbb',
          claims: [
            { type: 'git' as const, canonical: 'github.com/acme/atlas' },
          ],
        },
      ],
    };
    const merged = mergePortableSnapshot(a, snapshot);
    expect(merged.conflicts.length).toBeGreaterThan(0);
    // Both records are preserved; neither silently absorbs the other.
    expect(merged.registry.projects).toHaveLength(2);
    expect(registryConflicts(merged.registry).length).toBeGreaterThan(0);
    // Resolution of the shared identity now reports a conflict, not a pick.
    expect(
      resolveProjectForIdentity(merged.registry, git('github.com/acme/atlas'))
        .status,
    ).toBe('conflict');
  });

  it('git claims compare case-insensitively; legacy compat keys are exact', () => {
    expect(claimKey(identityClaim(git('GitHub.com/Acme/Atlas')))).toBe(
      claimKey(identityClaim(git('github.com/acme/atlas'))),
    );
  });
});

describe('name hints (machine-local, never portable)', () => {
  it('setNameHint adds a hint retrievable by nameHintFor', () => {
    const registry = setNameHint(emptyRegistry(), 'prj_abc123', 'nexus');
    expect(nameHintFor(registry, 'prj_abc123')).toBe('nexus');
  });

  it('nameHintFor returns undefined when no hint exists', () => {
    expect(nameHintFor(emptyRegistry(), 'prj_abc123')).toBeUndefined();
  });

  it('setNameHint replaces an existing hint for the same projectId rather than duplicating', () => {
    let registry = setNameHint(emptyRegistry(), 'prj_abc123', 'old-name');
    registry = setNameHint(registry, 'prj_abc123', 'new-name');
    expect(nameHintFor(registry, 'prj_abc123')).toBe('new-name');
    expect(registry.nameHints).toHaveLength(1);
  });

  it('is absent from a fresh empty registry', () => {
    expect(emptyRegistry().nameHints).toEqual([]);
  });

  it('never mutates the input registry', () => {
    const before: LocalRegistry = emptyRegistry();
    const snapshot = JSON.parse(JSON.stringify(before));
    setNameHint(before, 'prj_abc123', 'nexus');
    expect(before).toEqual(snapshot);
  });
});

describe('setExplicitNameHint (stak project name — user-set display names)', () => {
  it('sets a name retrievable by nameHintFor, marked explicit', () => {
    const registry = setExplicitNameHint(
      emptyRegistry(),
      'prj_abc123',
      'nexus',
    );
    expect(nameHintFor(registry, 'prj_abc123')).toBe('nexus');
    expect(nameHintIsExplicit(registry, 'prj_abc123')).toBe(true);
  });

  it('a later discovery-time setNameHint call never overwrites an explicit name', () => {
    let registry = setExplicitNameHint(emptyRegistry(), 'prj_abc123', 'nexus');
    registry = setNameHint(registry, 'prj_abc123', 'some-other-basename');
    expect(nameHintFor(registry, 'prj_abc123')).toBe('nexus');
    expect(nameHintIsExplicit(registry, 'prj_abc123')).toBe(true);
  });

  it('a later explicit rename DOES replace a previous explicit name', () => {
    let registry = setExplicitNameHint(
      emptyRegistry(),
      'prj_abc123',
      'old-name',
    );
    registry = setExplicitNameHint(registry, 'prj_abc123', 'new-name');
    expect(nameHintFor(registry, 'prj_abc123')).toBe('new-name');
  });

  it('an explicit name can replace a prior discovery-time hint', () => {
    let registry = setNameHint(
      emptyRegistry(),
      'prj_abc123',
      'discovered-basename',
    );
    registry = setExplicitNameHint(registry, 'prj_abc123', 'renamed');
    expect(nameHintFor(registry, 'prj_abc123')).toBe('renamed');
    expect(nameHintIsExplicit(registry, 'prj_abc123')).toBe(true);
  });

  it('nameHintIsExplicit is false for a discovery-time hint and for no hint at all', () => {
    const withDiscovered = setNameHint(emptyRegistry(), 'prj_abc123', 'x');
    expect(nameHintIsExplicit(withDiscovered, 'prj_abc123')).toBe(false);
    expect(nameHintIsExplicit(emptyRegistry(), 'prj_abc123')).toBe(false);
  });

  it('never mutates the input registry', () => {
    const before: LocalRegistry = emptyRegistry();
    const snapshot = JSON.parse(JSON.stringify(before));
    setExplicitNameHint(before, 'prj_abc123', 'nexus');
    expect(before).toEqual(snapshot);
  });
});

describe('adoptReconciledProjectId (identity reconciliation — one logical Project, never two)', () => {
  it('merges claims from the obsolete id into the authoritative id and drops the obsolete record', () => {
    let registry = emptyRegistry();
    registry = resolveOrMintProject(
      registry,
      { kind: 'local', vendorKey: 'L' },
      () => 'prj_from00000000000000000001',
    ).registry;
    registry = resolveOrMintProject(
      registry,
      git('github.com/usestak/stak'),
      () => 'prj_to000000000000000000001',
    ).registry;

    const merged = adoptReconciledProjectId(
      registry,
      'prj_from00000000000000000001',
      'prj_to000000000000000000001',
    );

    expect(merged.projects.map((p) => p.projectId)).toEqual([
      'prj_to000000000000000000001',
    ]);
    expect(
      resolveProjectForIdentity(merged, { kind: 'local', vendorKey: 'L' }),
    ).toEqual({
      status: 'resolved',
      projectId: 'prj_to000000000000000000001',
    });
    expect(
      resolveProjectForIdentity(merged, git('github.com/usestak/stak')),
    ).toEqual({
      status: 'resolved',
      projectId: 'prj_to000000000000000000001',
    });
  });

  it('creates the surviving record under toProjectId even when this registry has never seen it before', () => {
    let registry = emptyRegistry();
    registry = resolveOrMintProject(
      registry,
      git('github.com/usestak/stak'),
      () => 'prj_from00000000000000000001',
    ).registry;

    // toProjectId (Cloud's existing, authoritative id) is NOT present locally yet.
    const merged = adoptReconciledProjectId(
      registry,
      'prj_from00000000000000000001',
      'prj_cloud0000000000000000001',
    );

    expect(merged.projects).toEqual([
      {
        projectId: 'prj_cloud0000000000000000001',
        claims: [identityClaim(git('github.com/usestak/stak'))],
        lifecycle: 'active',
      },
    ]);
  });

  it('retargets a binding on the obsolete id to the authoritative id', () => {
    let registry = emptyRegistry();
    registry = resolveOrMintProject(
      registry,
      { kind: 'local', vendorKey: 'L' },
      () => 'prj_from00000000000000000001',
    ).registry;
    registry = setBinding(registry, {
      projectId: 'prj_from00000000000000000001',
      dir: 'D:\\Work\\nexus',
      boundAt: '2026-10-17T00:00:00.000Z',
      provenance: 'user-map',
    });

    const merged = adoptReconciledProjectId(
      registry,
      'prj_from00000000000000000001',
      'prj_to000000000000000000001',
    );

    expect(bindingFor(merged, 'prj_to000000000000000000001')?.dir).toBe(
      'D:\\Work\\nexus',
    );
    expect(bindingFor(merged, 'prj_from00000000000000000001')).toBeUndefined();
  });

  it('prefers the authoritative id binding/name hint when both ids have one', () => {
    let registry = emptyRegistry();
    registry = resolveOrMintProject(
      registry,
      { kind: 'local', vendorKey: 'L' },
      () => 'prj_from00000000000000000001',
    ).registry;
    registry = resolveOrMintProject(
      registry,
      git('github.com/usestak/stak'),
      () => 'prj_to000000000000000000001',
    ).registry;
    registry = setBinding(registry, {
      projectId: 'prj_from00000000000000000001',
      dir: 'C:\\old\\path',
      boundAt: '2026-10-17T00:00:00.000Z',
      provenance: 'user-map',
    });
    registry = setBinding(registry, {
      projectId: 'prj_to000000000000000000001',
      dir: 'C:\\Users\\NT\\Desktop\\stack',
      boundAt: '2026-10-17T00:00:00.000Z',
      provenance: 'user-map',
    });

    const merged = adoptReconciledProjectId(
      registry,
      'prj_from00000000000000000001',
      'prj_to000000000000000000001',
    );

    expect(bindingFor(merged, 'prj_to000000000000000000001')?.dir).toBe(
      'C:\\Users\\NT\\Desktop\\stack',
    );
  });

  it('an explicit name hint on the OBSOLETE id survives reconciliation onto the authoritative id', () => {
    let registry = emptyRegistry();
    registry = resolveOrMintProject(
      registry,
      { kind: 'local', vendorKey: 'L' },
      () => 'prj_from00000000000000000001',
    ).registry;
    registry = resolveOrMintProject(
      registry,
      git('github.com/usestak/stak'),
      () => 'prj_to000000000000000000001',
    ).registry;
    registry = setExplicitNameHint(
      registry,
      'prj_from00000000000000000001',
      'my nickname',
    );

    const merged = adoptReconciledProjectId(
      registry,
      'prj_from00000000000000000001',
      'prj_to000000000000000000001',
    );

    expect(nameHintFor(merged, 'prj_to000000000000000000001')).toBe(
      'my nickname',
    );
    expect(nameHintIsExplicit(merged, 'prj_to000000000000000000001')).toBe(
      true,
    );
  });

  it('an explicit name hint on the AUTHORITATIVE id wins over a plain discovery hint on the obsolete id', () => {
    let registry = emptyRegistry();
    registry = resolveOrMintProject(
      registry,
      { kind: 'local', vendorKey: 'L' },
      () => 'prj_from00000000000000000001',
    ).registry;
    registry = resolveOrMintProject(
      registry,
      git('github.com/usestak/stak'),
      () => 'prj_to000000000000000000001',
    ).registry;
    registry = setNameHint(
      registry,
      'prj_from00000000000000000001',
      'discovered-basename',
    );
    registry = setExplicitNameHint(
      registry,
      'prj_to000000000000000000001',
      'explicit-name',
    );

    const merged = adoptReconciledProjectId(
      registry,
      'prj_from00000000000000000001',
      'prj_to000000000000000000001',
    );

    expect(nameHintFor(merged, 'prj_to000000000000000000001')).toBe(
      'explicit-name',
    );
  });

  it('is a no-op when the two ids are already the same', () => {
    let registry = emptyRegistry();
    registry = resolveOrMintProject(
      registry,
      git('github.com/usestak/stak'),
      () => 'prj_a0000000000000000000001',
    ).registry;
    const result = adoptReconciledProjectId(
      registry,
      'prj_a0000000000000000000001',
      'prj_a0000000000000000000001',
    );
    expect(result).toEqual(registry);
  });

  it('is a no-op when the obsolete id does not exist in this registry', () => {
    const registry = emptyRegistry();
    const result = adoptReconciledProjectId(
      registry,
      'prj_from00000000000000000001',
      'prj_to000000000000000000001',
    );
    expect(result).toEqual(registry);
  });

  it('never mutates the input registry', () => {
    let registry = emptyRegistry();
    registry = resolveOrMintProject(
      registry,
      { kind: 'local', vendorKey: 'L' },
      () => 'prj_from00000000000000000001',
    ).registry;
    registry = resolveOrMintProject(
      registry,
      git('github.com/usestak/stak'),
      () => 'prj_to000000000000000000001',
    ).registry;
    const snapshot = JSON.parse(JSON.stringify(registry));
    adoptReconciledProjectId(
      registry,
      'prj_from00000000000000000001',
      'prj_to000000000000000000001',
    );
    expect(registry).toEqual(snapshot);
  });
});

describe('composeBundleSnapshot', () => {
  const setUp = () => {
    counter = 0;
    // Local machine knows L (its own project) only.
    const ownMinted = resolveOrMintProject(emptyRegistry(), git('github.com/o/mine'), mint);
    const localReg = setBinding(ownMinted.registry, {
      projectId: ownMinted.projectId,
      dir: '/home/me/mine',
      boundAt: '2026-10-26T00:00:00.000Z',
      provenance: 'user-map',
    });
    // Remote snapshot knows L (with a different claim), X (in main), Y (not in main),
    // and Z (in main, but claims L's repo under another ID).
    const remoteReg = resolveOrMintProject(emptyRegistry(), git('github.com/o/x'), mint);
    const xId = remoteReg.projectId;
    const y = resolveOrMintProject(remoteReg.registry, git('github.com/o/y'), mint);
    const z = resolveOrMintProject(emptyRegistry(), git('github.com/o/mine'), mint);
    const remote = toPortableSnapshot({
      ...y.registry,
      projects: [
        ...y.registry.projects,
        { projectId: ownMinted.projectId, claims: [identityClaim(git('github.com/o/other'))] },
        ...z.registry.projects,
      ],
    });
    return { localReg, ownId: ownMinted.projectId, xId, yId: y.projectId, zId: z.projectId, remote };
  };

  it('carries remote records only for projects in main that have no local record, and keeps local records', () => {
    const { localReg, ownId, xId, yId, zId, remote } = setUp();
    const { snapshot, carried, conflicts } = composeBundleSnapshot(localReg, remote, [ownId, xId, zId]);
    expect(carried).toEqual([xId]);
    const ids = snapshot.projects.map((p) => p.projectId);
    expect(ids).toContain(ownId);
    expect(ids).toContain(xId);
    expect(ids).not.toContain(yId); // not in main
    expect(ids).not.toContain(zId); // its claim is held locally by another ID
    // Shared ID: local claims kept, plus the compatible remote claim (union).
    const ownClaims = snapshot.projects.find((p) => p.projectId === ownId)?.claims.map(claimKey);
    expect(ownClaims).toEqual(['git:github.com/o/mine', 'git:github.com/o/other']);
    expect(conflicts).toEqual([{ kind: 'claim-held-locally', projectId: zId, heldBy: ownId }]);
    // The local registry itself is untouched.
    expect(localReg.projects[0]?.claims.map(claimKey)).toEqual(['git:github.com/o/mine']);
    expect(JSON.stringify(snapshot)).not.toContain('/home/me');
    expect(JSON.stringify(snapshot)).not.toContain('bindings');
  });

  it('a remote claim on a shared ID that ANOTHER local project holds is not added, and is reported', () => {
    counter = 0;
    const a = resolveOrMintProject(emptyRegistry(), git('github.com/o/a'), mint);
    const b = resolveOrMintProject(a.registry, git('github.com/o/b'), mint);
    const remote = {
      snapshotVersion: 1 as const,
      projects: [{ projectId: a.projectId, claims: [identityClaim(git('github.com/o/b'))] }],
    };
    const { snapshot, conflicts } = composeBundleSnapshot(b.registry, remote, [a.projectId]);
    expect(snapshot.projects.find((p) => p.projectId === a.projectId)?.claims.map(claimKey)).toEqual([
      'git:github.com/o/a',
    ]);
    expect(conflicts).toEqual([
      { kind: 'claim-held-by-other', projectId: a.projectId, claimKey: 'git:github.com/o/b', heldBy: b.projectId },
    ]);
  });

  it('without a remote snapshot it is exactly the local snapshot', () => {
    const { localReg, ownId } = setUp();
    expect(composeBundleSnapshot(localReg, undefined, [ownId]).snapshot).toEqual(toPortableSnapshot(localReg));
  });
});
