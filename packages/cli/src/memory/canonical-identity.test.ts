import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  emptyRegistry,
  encodeClaudeProjectKey,
  identityClaim,
  resolveOrMintProject,
  setBinding,
  type DiscoveredMemoryItem,
  type LocalRegistry,
  type ManifestItem,
} from '@stack/memory';

import {
  canonicalMemoryKey,
  reconcileNativeWithStagedMemory,
  resolveCanonicalProjectId,
} from './canonical-identity.js';

const item = (
  overrides: Partial<DiscoveredMemoryItem> & { vendorKey: string; rel: string; hash: string },
): DiscoveredMemoryItem => ({
  provider: 'claude',
  kind: 'auto-memory',
  scope: 'project',
  logicalId: `claude/auto-memory/local:${overrides.vendorKey}/${overrides.rel}`,
  project: { kind: 'local', vendorKey: overrides.vendorKey },
  contentHash: overrides.hash,
  restoreTarget: { base: 'claude-project-memory', relativePath: overrides.rel },
  source: { path: `/native/${overrides.vendorKey}/${overrides.rel}` },
  capturedAt: '2026-10-20T00:00:00.000Z',
  sensitivity: 'private',
  ...overrides,
});

const manifestItem = (
  overrides: Partial<ManifestItem> & { vendorKey: string; rel: string; hash: string },
): ManifestItem => ({
  provider: 'claude',
  kind: 'auto-memory',
  scope: 'project',
  logicalId: `claude/auto-memory/local:${overrides.vendorKey}/${overrides.rel}`,
  project: { kind: 'local', vendorKey: overrides.vendorKey },
  contentHash: overrides.hash,
  restoreTarget: { base: 'claude-project-memory', relativePath: overrides.rel },
  capturedAt: '2026-10-20T00:00:00.000Z',
  sensitivity: 'private',
  ...overrides,
});

describe('resolveCanonicalProjectId', () => {
  it('resolves via an existing registry CLAIM (e.g. the original capture location)', () => {
    const vendorKey = 'C--Users-NT-Desktop-swft';
    const minted = resolveOrMintProject(
      emptyRegistry(),
      { kind: 'local', vendorKey },
      () => 'prj_swftoriginal0000000000001',
    );
    const projectId = resolveCanonicalProjectId(
      item({ vendorKey, rel: 'f.md', hash: 'sha256:a' }),
      minted.registry,
    );
    expect(projectId).toBe(minted.projectId);
  });

  it('resolves a NEW, never-claimed location via an explicit machine BINDING (`stak project map`)', () => {
    const newDir = path.resolve('/tmp/stak-beta-swft-fresh');
    const newVendorKey = encodeClaudeProjectKey(newDir);
    const minted = resolveOrMintProject(
      emptyRegistry(),
      { kind: 'local', vendorKey: 'C--Users-NT-Desktop-swft' },
      () => 'prj_swftoriginal0000000000001',
    );
    const mapped = setBinding(minted.registry, {
      projectId: minted.projectId,
      dir: newDir,
      boundAt: '2026-10-20T00:00:00.000Z',
      provenance: 'user-map',
    });
    const projectId = resolveCanonicalProjectId(
      item({ vendorKey: newVendorKey, rel: 'f.md', hash: 'sha256:a' }),
      mapped,
    );
    expect(projectId).toBe(minted.projectId);
  });

  it('returns undefined when the identity is genuinely unknown (no claim, no binding)', () => {
    const projectId = resolveCanonicalProjectId(
      item({ vendorKey: 'C--Unrelated', rel: 'f.md', hash: 'sha256:a' }),
      emptyRegistry(),
    );
    expect(projectId).toBeUndefined();
  });

  it('returns undefined on a conflicted claim — never guesses', () => {
    const vendorKey = 'C--Conflicted';
    const claim = identityClaim({ kind: 'local', vendorKey });
    const registry: LocalRegistry = {
      schemaVersion: 1,
      projects: [
        { projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa', claims: [claim] },
        { projectId: 'prj_bbbbbbbbbbbbbbbbbbbbbbbbbb', claims: [claim] },
      ],
      bindings: [],
    };
    // (Artificial conflict via hand-built registry — resolveCanonicalProjectId must
    // still refuse to pick one.)
    const projectId = resolveCanonicalProjectId(
      item({ vendorKey, rel: 'f.md', hash: 'sha256:a' }),
      registry,
    );
    expect(projectId).toBeUndefined();
  });
});

describe('reconcileNativeWithStagedMemory — `stak add .` idempotent staging after relocation', () => {
  const reconciledRegistryWithBinding = (oldVendorKey: string, newDir: string) => {
    const minted = resolveOrMintProject(
      emptyRegistry(),
      { kind: 'local', vendorKey: oldVendorKey },
      () => 'prj_swftoriginal0000000000001',
    );
    return {
      projectId: minted.projectId,
      registry: setBinding(minted.registry, {
        projectId: minted.projectId,
        dir: path.resolve(newDir),
        boundAt: '2026-10-20T00:00:00.000Z',
        provenance: 'user-map',
      }),
    };
  };

  const oldVendorKey = 'C--Users-NT-Desktop-swft';
  const newDir = '/tmp/stak-beta-swft-fresh';
  const newVendorKey = encodeClaudeProjectKey(path.resolve(newDir));

  it('A: MAIN has the OLD-locator record, MACHINE now only discovers the NEW location (via binding) — no-op, nothing staged', () => {
    const { registry } = reconciledRegistryWithBinding(oldVendorKey, newDir);
    const staged = [manifestItem({ vendorKey: oldVendorKey, rel: 'feedback.md', hash: 'sha256:a' })];
    const native = [item({ vendorKey: newVendorKey, rel: 'feedback.md', hash: 'sha256:a' })];

    const plan = reconcileNativeWithStagedMemory(native, staged, registry);
    expect(plan.items).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('B: MAIN has OLD-locator, MACHINE discovers BOTH old + new (same hash) — no-op, no duplicate, no new identity', () => {
    const { registry } = reconciledRegistryWithBinding(oldVendorKey, newDir);
    const staged = [manifestItem({ vendorKey: oldVendorKey, rel: 'feedback.md', hash: 'sha256:a' })];
    const native = [
      item({ vendorKey: oldVendorKey, rel: 'feedback.md', hash: 'sha256:a' }),
      item({ vendorKey: newVendorKey, rel: 'feedback.md', hash: 'sha256:a' }),
    ];

    const plan = reconcileNativeWithStagedMemory(native, staged, registry);
    expect(plan.items).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('C: same as B but old vs new DIFFER in content — fails closed (conflict), never silently chooses either, never staged', () => {
    const { registry } = reconciledRegistryWithBinding(oldVendorKey, newDir);
    const staged = [manifestItem({ vendorKey: oldVendorKey, rel: 'feedback.md', hash: 'sha256:old' })];
    const native = [
      item({ vendorKey: oldVendorKey, rel: 'feedback.md', hash: 'sha256:old' }),
      item({ vendorKey: newVendorKey, rel: 'feedback.md', hash: 'sha256:new' }),
    ];

    const plan = reconcileNativeWithStagedMemory(native, staged, registry);
    expect(plan.items).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(1);
    expect(new Set(plan.conflicts[0]?.items.map((i) => i.contentHash))).toEqual(
      new Set(['sha256:old', 'sha256:new']),
    );
  });

  it('D/E: fresh machine — MAIN already holds the restored canonical record, re-running add . after restore is a no-op', () => {
    const { registry } = reconciledRegistryWithBinding(oldVendorKey, newDir);
    // "restore" already wrote the canonical entry (new vendor key payload, same logical
    // identity/content as before) into MAIN.
    const staged = [manifestItem({ vendorKey: newVendorKey, rel: 'feedback.md', hash: 'sha256:a' })];
    const native = [item({ vendorKey: newVendorKey, rel: 'feedback.md', hash: 'sha256:a' })];

    const plan = reconcileNativeWithStagedMemory(native, staged, registry);
    expect(plan.items).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('F: running the reconcile twice in a row is idempotent (content genuinely changed once, then settles)', () => {
    const { registry } = reconciledRegistryWithBinding(oldVendorKey, newDir);
    const staged = [manifestItem({ vendorKey: oldVendorKey, rel: 'feedback.md', hash: 'sha256:old' })];
    const native = [item({ vendorKey: newVendorKey, rel: 'feedback.md', hash: 'sha256:new' })];

    const first = reconcileNativeWithStagedMemory(native, staged, registry);
    expect(first.items).toHaveLength(1);
    const [firstPlanItem] = first.items;
    if (!firstPlanItem) throw new Error('expected a reconciled item');
    // Simulate the commit: MAIN now holds the updated entry under its EXISTING
    // logical identity (not a fresh one derived from the new vendor key).
    expect(firstPlanItem.logicalId).toBe(staged[0]?.logicalId);
    const updatedStaged = [
      { ...staged[0], contentHash: firstPlanItem.contentHash } as ManifestItem,
    ];

    const second = reconcileNativeWithStagedMemory(native, updatedStaged, registry);
    expect(second.items).toHaveLength(0);
    expect(second.conflicts).toHaveLength(0);
  });

  it('G: a genuinely new identity prefers whichever native copy already carries a registry CLAIM, never a bare binding-only copy', () => {
    const { registry, projectId } = reconciledRegistryWithBinding(oldVendorKey, newDir);
    // Nothing staged yet for this logical path at all.
    const native = [
      item({ vendorKey: oldVendorKey, rel: 'brand-new.md', hash: 'sha256:a' }),
      item({ vendorKey: newVendorKey, rel: 'brand-new.md', hash: 'sha256:a' }),
    ];

    const plan = reconcileNativeWithStagedMemory(native, [], registry);
    expect(plan.items).toHaveLength(1);
    const [planned] = plan.items;
    if (!planned) throw new Error('expected a reconciled item');
    expect(resolveCanonicalProjectId(planned, registry)).toBe(projectId);
    // The staged item's raw identity is the CLAIMED (old-locator) one, not the
    // binding-only new one — so registry sync never mints a second Project.
    expect(planned.project).toEqual({ kind: 'local', vendorKey: oldVendorKey });
  });

  it('H: a Git-reconciled relocation (claim-based, not binding-based) gets the identical no-op behavior', () => {
    const gitIdentity = {
      kind: 'git' as const,
      canonical: 'github.com/acme/swft',
      host: 'github.com',
      owner: 'acme',
      repo: 'swft',
    };
    const minted = resolveOrMintProject(
      emptyRegistry(),
      gitIdentity,
      () => 'prj_gitreconciled000000000001',
    );
    const staged = [
      manifestItem({
        vendorKey: oldVendorKey,
        rel: 'feedback.md',
        hash: 'sha256:a',
        project: gitIdentity,
      }),
    ];
    const native = [
      item({
        vendorKey: newVendorKey,
        rel: 'feedback.md',
        hash: 'sha256:a',
        project: gitIdentity,
      }),
    ];

    const plan = reconcileNativeWithStagedMemory(native, staged, minted.registry);
    expect(plan.items).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('I: unrelated Projects with the same filename/hash never merge, even against an existing staged record', () => {
    const staged = [manifestItem({ vendorKey: 'C--project-one', rel: 'notes.md', hash: 'sha256:same' })];
    const native = [item({ vendorKey: 'C--project-two', rel: 'notes.md', hash: 'sha256:same' })];

    const plan = reconcileNativeWithStagedMemory(native, staged, emptyRegistry());
    // The native item has no staged counterpart under its OWN (unrelated) canonical
    // key — a genuinely new, distinct identity, staged as its own record.
    expect(plan.items).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(0);
    const [planned] = plan.items;
    const [existing] = staged;
    if (!planned || !existing) throw new Error('expected fixture items');
    expect(canonicalMemoryKey(planned, emptyRegistry())).not.toBe(
      canonicalMemoryKey(existing, emptyRegistry()),
    );
  });

  it('J: an existing historical manifest entry under the OLD locator is reused unchanged (never rewritten) when native content merely confirms it', () => {
    const { registry } = reconciledRegistryWithBinding(oldVendorKey, newDir);
    const staged = [manifestItem({ vendorKey: oldVendorKey, rel: 'feedback.md', hash: 'sha256:a' })];
    const native = [item({ vendorKey: newVendorKey, rel: 'feedback.md', hash: 'sha256:a' })];

    const plan = reconcileNativeWithStagedMemory(native, staged, registry);
    // Nothing staged: the existing OLD-locator entry is left exactly as-is via the
    // caller's own carry-forward, never replaced by a new-locator rewrite.
    expect(plan.items).toHaveLength(0);
  });
});
