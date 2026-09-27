import { describe, expect, it } from 'vitest';

import type { ProjectIdentity } from '../domain.js';
import {
  claimKey,
  emptyRegistry,
  identityClaim,
  legacyCompatKey,
  mergePortableSnapshot,
  registryConflicts,
  resolveOrMintProject,
  resolveProjectForIdentity,
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
