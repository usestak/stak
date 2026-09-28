import { describe, expect, it } from 'vitest';

import type { ProjectIdentity } from '../domain.js';
import {
  bindingFor,
  mergePortableSnapshot,
  registryConflicts,
  resolveOrMintProject,
  resolveProjectForIdentity,
  setBinding,
  toPortableSnapshot,
  emptyRegistry,
} from './registry.js';

/**
 * Phase 15B.1 — concurrent legacy-migration safety and `legacy-compat` claim
 * semantics.
 *
 * When two machines independently recover the SAME pre-registry historical bundle
 * before either has made a registry-bearing backup, each mints a DIFFERENT random
 * Project ID for the same historical (legacy `local:`) reference. That divergence is
 * acceptable in the first-upgrade window. What must never happen is a silent merge,
 * a silent reassignment of Memory between Project IDs, a filesystem path becoming
 * authority, or data loss when those registries later meet.
 */
const local = (vendorKey: string): ProjectIdentity => ({
  kind: 'local',
  vendorKey,
});

const mintSeq = (prefix: string) => {
  let n = 0;
  return () => `prj_${prefix}${(n++).toString(36).padStart(23, '0')}`;
};

describe('concurrent legacy migration', () => {
  it('surfaces a deterministic conflict instead of silently merging divergent IDs', () => {
    const VENDOR = 'C--Users-NT-Desktop-nexus';

    // Machine A migrates the legacy reference to prj_a...
    const a = resolveOrMintProject(
      emptyRegistry(),
      local(VENDOR),
      mintSeq('a'),
    );
    expect(a.minted).toBe(true);

    // Machine B independently migrates the SAME reference to a different prj_b...
    let bReg = resolveOrMintProject(
      emptyRegistry(),
      local(VENDOR),
      mintSeq('b'),
    ).registry;
    const bId = bReg.projects[0]?.projectId as string;
    expect(bId).not.toBe(a.projectId);

    // B has an explicit machine binding for its own migrated project.
    bReg = setBinding(bReg, {
      projectId: bId,
      dir: 'D:\\work\\nexus',
      boundAt: '2026-09-28T00:00:00.000Z',
      provenance: 'user-map',
    });

    // Later, A's registry-bearing backup arrives on B.
    const merged = mergePortableSnapshot(bReg, toPortableSnapshot(a.registry));

    // Conflict is surfaced deterministically (sorted ids), not silently merged.
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]?.projectIds).toEqual([a.projectId, bId].sort());
    expect(registryConflicts(merged.registry)).toHaveLength(1);

    // Both records are preserved — no last-writer-wins, no reassignment.
    expect(merged.registry.projects.map((r) => r.projectId).sort()).toEqual(
      [a.projectId, bId].sort(),
    );

    // The machine-local binding is untouched.
    const binding = bindingFor(merged.registry, bId);
    expect(binding?.dir).toBe('D:\\work\\nexus');

    // Resolution now reports a conflict rather than picking one silently.
    expect(
      resolveProjectForIdentity(merged.registry, local(VENDOR)).status,
    ).toBe('conflict');
  });

  it('is idempotent when the same snapshot is merged twice (no duplicate records)', () => {
    const a = resolveOrMintProject(
      emptyRegistry(),
      local('C--x-y'),
      mintSeq('a'),
    );
    const snap = toPortableSnapshot(a.registry);
    const once = mergePortableSnapshot(emptyRegistry(), snap);
    const twice = mergePortableSnapshot(once.registry, snap);
    expect(twice.conflicts).toEqual([]);
    expect(twice.registry.projects).toHaveLength(1);
  });
});

describe('legacy-compat claim semantics', () => {
  it('resolves a single legacy project by its compatibility reference only', () => {
    const reg = resolveOrMintProject(
      emptyRegistry(),
      local('C--Users-NT-Desktop-widget'),
      mintSeq('a'),
    ).registry;
    const resolution = resolveProjectForIdentity(
      reg,
      local('C--Users-NT-Desktop-widget'),
    );
    expect(resolution.status).toBe('resolved');
    // The record's claim is the opaque compat digest, never the raw path.
    const claim = reg.projects[0]?.claims[0];
    expect(claim?.type).toBe('legacy-compat');
    if (claim?.type === 'legacy-compat')
      expect(claim.key).not.toContain('widget');
  });

  it('two records sharing one compatibility reference cannot resolve silently', () => {
    const reg = mergePortableSnapshot(
      {
        schemaVersion: 1,
        projects: [
          {
            projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
            claims: [{ type: 'legacy-compat', key: 'compat:deadbeef' }],
          },
        ],
        bindings: [],
      },
      {
        snapshotVersion: 1,
        projects: [
          {
            projectId: 'prj_bbbbbbbbbbbbbbbbbbbbbbbbbb',
            claims: [{ type: 'legacy-compat', key: 'compat:deadbeef' }],
          },
        ],
      },
    );
    // Both records are preserved and the shared reference is a standing conflict,
    // so nothing can resolve (and therefore restore) it silently.
    expect(reg.conflicts).toHaveLength(1);
    expect(reg.registry.projects).toHaveLength(2);
    expect(registryConflicts(reg.registry)).toHaveLength(1);
  });
});
