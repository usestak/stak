import { describe, expect, it } from 'vitest';
import type { MemoryManifest } from '../domain.js';
import { emptyRegistry, resolveOrMintProject, toPortableSnapshot } from '../project/registry.js';
import type { MemoryBackupBundle } from '../remote/bundle-codec.js';
import { convertV1Bundle } from './convert-v1.js';

const h = (n: number) => `sha256:${n.toString().padStart(64, '0')}`;

const makeBundle = (
  manifest: MemoryManifest,
  registrySnapshot?: unknown,
): MemoryBackupBundle => ({
  bundleFormat: 'stack-mem-bundle-v1',
  provider: 'claude',
  manifestSha256: h(0),
  manifestB64: Buffer.from(JSON.stringify(manifest)).toString('base64'),
  objects: [],
  ...(registrySnapshot
    ? {
        registrySha256: h(0),
        registryB64: Buffer.from(JSON.stringify(registrySnapshot)).toString('base64'),
      }
    : {}),
});

describe('convertV1Bundle', () => {
  it('is deterministic when the bundle carries its registry snapshot, across two different local registries', () => {
    const identity = { kind: 'git' as const, canonical: 'github.com/acme/widgets', host: 'github.com', owner: 'acme', repo: 'widgets' };
    let registry = emptyRegistry();
    const minted = resolveOrMintProject(registry, identity);
    registry = minted.registry;
    const snapshot = toPortableSnapshot(registry);

    const manifest: MemoryManifest = {
      schemaVersion: 1,
      provider: 'claude',
      createdAt: '2026-10-20T00:00:00.000Z',
      items: [
        {
          provider: 'claude',
          kind: 'auto-memory',
          scope: 'project',
          logicalId: 'claude/auto-memory/github.com/acme/widgets/a.md',
          project: identity,
          contentHash: h(1),
          restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
          capturedAt: '2026-10-20T00:00:00.000Z',
          sensitivity: 'private',
        },
      ],
    };
    const bundle = makeBundle(manifest, snapshot);

    const resultA = convertV1Bundle(bundle);
    // A DIFFERENT local registry (e.g. a different machine's) must not change the
    // result when the bundle carries its own snapshot.
    const differentLocalRegistry = emptyRegistry();
    const resultB = convertV1Bundle(bundle, { localRegistry: differentLocalRegistry });
    expect(resultA).toEqual(resultB);
    expect(resultA.projects[0]?.projectId).toBe(minted.projectId);
    expect(resultA.projects[0]?.documents).toEqual([
      { path: 'notes/a.md', state: 'present', contentHash: h(1), importedFrom: 'claude', importedAt: '2026-10-20T00:00:00.000Z' },
    ]);
  });

  it('falls back to the provided local registry when the bundle has no snapshot', () => {
    const identity = { kind: 'local' as const, vendorKey: 'key-1' };
    let registry = emptyRegistry();
    const minted = resolveOrMintProject(registry, identity);
    registry = minted.registry;

    const manifest: MemoryManifest = {
      schemaVersion: 1,
      provider: 'claude',
      createdAt: '2026-10-20T00:00:00.000Z',
      items: [
        {
          provider: 'claude',
          kind: 'auto-memory',
          scope: 'project',
          logicalId: 'claude/auto-memory/local:key-1/a.md',
          project: identity,
          contentHash: h(1),
          restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
          capturedAt: '2026-10-20T00:00:00.000Z',
          sensitivity: 'private',
        },
      ],
    };
    const bundle = makeBundle(manifest); // no registrySnapshot
    const result = convertV1Bundle(bundle, { localRegistry: registry });
    expect(result.projects[0]?.projectId).toBe(minted.projectId);
  });

  it('skips a project-scope item that resolves to no claim in either source (fail closed, never guesses)', () => {
    const identity = { kind: 'local' as const, vendorKey: 'unregistered-key' };
    const manifest: MemoryManifest = {
      schemaVersion: 1,
      provider: 'claude',
      createdAt: '2026-10-20T00:00:00.000Z',
      items: [
        {
          provider: 'claude',
          kind: 'auto-memory',
          scope: 'project',
          logicalId: 'claude/auto-memory/local:unregistered-key/a.md',
          project: identity,
          contentHash: h(1),
          restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
          capturedAt: '2026-10-20T00:00:00.000Z',
          sensitivity: 'private',
        },
      ],
    };
    const bundle = makeBundle(manifest);
    const result = convertV1Bundle(bundle, { localRegistry: emptyRegistry() });
    expect(result.projects).toEqual([]);
  });

  it('drops (never guesses) an item whose identity the bundle snapshot and the local registry claim under DIFFERENT Project IDs', () => {
    // The bundle's own snapshot claims `identity` under Project ID A. The caller's
    // local registry (e.g. this machine's own registry, independently) claims the
    // SAME identity under a DIFFERENT Project ID B. After merging the snapshot
    // into the local registry, both A and B records carry the same claim key, so
    // `resolveProjectForIdentity` reports a 'conflict' rather than resolving to
    // either one — the item must be dropped, never silently assigned to A, B, or
    // any guessed winner.
    const identity = {
      kind: 'git' as const,
      canonical: 'github.com/acme/contested',
      host: 'github.com',
      owner: 'acme',
      repo: 'contested',
    };
    const bundleSideRegistry = resolveOrMintProject(emptyRegistry(), identity);
    const snapshot = toPortableSnapshot(bundleSideRegistry.registry);
    const localSideRegistry = resolveOrMintProject(emptyRegistry(), identity);
    expect(localSideRegistry.projectId).not.toBe(bundleSideRegistry.projectId);

    const manifest: MemoryManifest = {
      schemaVersion: 1,
      provider: 'claude',
      createdAt: '2026-10-22T00:00:00.000Z',
      items: [
        {
          provider: 'claude',
          kind: 'auto-memory',
          scope: 'project',
          logicalId: 'claude/auto-memory/github.com/acme/contested/a.md',
          project: identity,
          contentHash: h(1),
          restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
          capturedAt: '2026-10-22T00:00:00.000Z',
          sensitivity: 'private',
        },
      ],
    };
    const bundle = makeBundle(manifest, snapshot);
    const result = convertV1Bundle(bundle, { localRegistry: localSideRegistry.registry });
    expect(result.projects).toEqual([]); // dropped, not assigned to either A or B
  });
});
