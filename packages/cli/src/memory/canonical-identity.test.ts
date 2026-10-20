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
} from '@stack/memory';

import {
  normalizeNativeMemoryItems,
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

describe('normalizeNativeMemoryItems — relocated-project dedup', () => {
  const reconciledRegistryWithBinding = (oldVendorKey: string, newDir: string) => {
    const minted = resolveOrMintProject(
      emptyRegistry(),
      { kind: 'local', vendorKey: oldVendorKey },
      () => 'prj_swftoriginal0000000000001',
    );
    return setBinding(minted.registry, {
      projectId: minted.projectId,
      dir: path.resolve(newDir),
      boundAt: '2026-10-20T00:00:00.000Z',
      provenance: 'user-map',
    });
  };

  it('A/B: a single native location (old or new) with a provable Project identity passes through unchanged', () => {
    const registry = reconciledRegistryWithBinding(
      'C--Users-NT-Desktop-swft',
      '/tmp/stak-beta-swft-fresh',
    );
    const native = [item({ vendorKey: 'C--Users-NT-Desktop-swft', rel: 'f.md', hash: 'sha256:a' })];
    expect(normalizeNativeMemoryItems(native, registry)).toHaveLength(1);
  });

  it('C: old + new native locations present, same Project/path/hash — dedupes to ONE logical item', () => {
    const newDir = '/tmp/stak-beta-swft-fresh';
    const newVendorKey = encodeClaudeProjectKey(path.resolve(newDir));
    const registry = reconciledRegistryWithBinding('C--Users-NT-Desktop-swft', newDir);
    const native = [
      item({ vendorKey: 'C--Users-NT-Desktop-swft', rel: 'feedback.md', hash: 'sha256:same' }),
      item({ vendorKey: newVendorKey, rel: 'feedback.md', hash: 'sha256:same' }),
    ];
    const result = normalizeNativeMemoryItems(native, registry);
    expect(result).toHaveLength(1);
    expect(result[0]?.contentHash).toBe('sha256:same');
  });

  it('D: old + new native locations, same Project/path but DIFFERENT hashes — never silently merged, both kept', () => {
    const newDir = '/tmp/stak-beta-swft-fresh';
    const newVendorKey = encodeClaudeProjectKey(path.resolve(newDir));
    const registry = reconciledRegistryWithBinding('C--Users-NT-Desktop-swft', newDir);
    const native = [
      item({ vendorKey: 'C--Users-NT-Desktop-swft', rel: 'feedback.md', hash: 'sha256:old' }),
      item({ vendorKey: newVendorKey, rel: 'feedback.md', hash: 'sha256:new' }),
    ];
    const result = normalizeNativeMemoryItems(native, registry);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((r) => r.contentHash))).toEqual(
      new Set(['sha256:old', 'sha256:new']),
    );
  });

  it('E: true fresh machine, new path only — passes through as one item (nothing to dedupe)', () => {
    const newDir = '/tmp/stak-beta-swft-fresh';
    const newVendorKey = encodeClaudeProjectKey(path.resolve(newDir));
    const registry = reconciledRegistryWithBinding('C--Users-NT-Desktop-swft', newDir);
    const native = [item({ vendorKey: newVendorKey, rel: 'feedback.md', hash: 'sha256:a' })];
    const result = normalizeNativeMemoryItems(native, registry);
    expect(result).toHaveLength(1);
  });

  it('F: unrelated Projects with the same filename/hash never merge', () => {
    const registry = emptyRegistry(); // neither identity is claimed or bound to anything
    const native = [
      item({ vendorKey: 'C--project-one', rel: 'notes.md', hash: 'sha256:same' }),
      item({ vendorKey: 'C--project-two', rel: 'notes.md', hash: 'sha256:same' }),
    ];
    const result = normalizeNativeMemoryItems(native, registry);
    expect(result).toHaveLength(2);
  });
});
