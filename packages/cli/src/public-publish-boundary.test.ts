import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { preparePublish } from '@stack/core';
import type { PublishClient } from '@stack/core';
import {
  hashBytes,
  readLocalRegistry,
  readPortableSnapshot,
  setBinding,
  syncRegistryForBackup,
  writeLocalRegistry,
  writeMemoryManifest,
  writeMemoryObject,
  type ManifestItem,
  type MemoryManifest,
} from '@stack/memory';

/**
 * Phase 15B.1 — the exact regression the 15B brief asked for: run the real public
 * Stack publish PREPARATION + SERIALIZATION path on a machine whose Stack home is
 * full of private project-registry state (Project IDs, private Git claims, legacy
 * compatibility keys, machine bindings, unresolved-project metadata, and Memory) and
 * prove none of it enters the public artifact. No network publish occurs: the fake
 * client only answers `me`/`getPublicStack`, and we also assemble the exact payload
 * `applyPublish` would transmit and assert on it.
 */
const roots: string[] = [];
const tempDir = async (prefix: string) => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

const SECRET_MEMORY = 'TOPSECRETMEMORYBODY';
const LEGACY_VENDOR_KEY = 'C--Users-PRIVATE-Desktop-nexus';
const BINDING_DIR = path.join('C:', 'private', 'binding', 'destination');

/** A stackHome populated with a full private project registry + bindings + Memory. */
const seedPrivateMemoryState = async (): Promise<{
  stackHome: string;
  memoryHash: string;
}> => {
  const stackHome = await tempDir('stack-boundary-home-');
  const atlasBytes = Buffer.from(`# atlas\n${SECRET_MEMORY}\n`, 'utf8');
  const nexusBytes = Buffer.from(`# nexus\n${SECRET_MEMORY}\n`, 'utf8');
  const atlasHash = hashBytes(atlasBytes);
  const nexusHash = hashBytes(nexusBytes);
  await writeMemoryObject({
    stackHome,
    contentHash: atlasHash,
    bytes: atlasBytes,
  });
  await writeMemoryObject({
    stackHome,
    contentHash: nexusHash,
    bytes: nexusBytes,
  });
  const items: ManifestItem[] = [
    {
      provider: 'claude',
      kind: 'auto-memory',
      scope: 'project',
      logicalId: 'claude/auto-memory/github.com/private-org/secret-repo/a.md',
      project: {
        kind: 'git',
        canonical: 'github.com/private-org/secret-repo',
        host: 'github.com',
        owner: 'private-org',
        repo: 'secret-repo',
      },
      contentHash: atlasHash,
      restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
      capturedAt: '2026-09-28T00:00:00.000Z',
      sensitivity: 'private',
    },
    {
      provider: 'claude',
      kind: 'auto-memory',
      scope: 'project',
      logicalId: `claude/auto-memory/local:${LEGACY_VENDOR_KEY}/n.md`,
      project: { kind: 'local', vendorKey: LEGACY_VENDOR_KEY },
      contentHash: nexusHash,
      restoreTarget: { base: 'claude-project-memory', relativePath: 'n.md' },
      capturedAt: '2026-09-28T00:00:00.000Z',
      sensitivity: 'private',
    },
  ];
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-28T00:00:00.000Z',
    items,
  };
  await writeMemoryManifest({ stackHome, manifest });
  // Mint Project IDs + write the portable snapshot, then add a machine binding.
  await syncRegistryForBackup({ stackHome });
  let registry = await readLocalRegistry(stackHome);
  registry = setBinding(registry, {
    projectId: registry.projects[0]?.projectId as string,
    dir: BINDING_DIR,
    boundAt: '2026-09-28T00:00:00.000Z',
    provenance: 'user-map',
  });
  await writeLocalRegistry(stackHome, registry);
  return { stackHome, memoryHash: atlasHash };
};

/** A real local git-backed authoring stack so publish resolves a reference source. */
const seedAuthoringStack = async (): Promise<string> => {
  const repo = await tempDir('stack-author-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/design.git']);
  await writeFile(
    path.join(repo, 'stak.yaml'),
    'schemaVersion: 1\nname: frontend\ndescription: Frontend Stack\nskills:\n  - path: skills/design\n',
    'utf8',
  );
  const skillDir = path.join(repo, 'skills', 'design');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: design\ndescription: Design engineering\n---\nDesign body.\n',
    'utf8',
  );
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
};

const fakeClient = (): PublishClient => ({
  me: async () => ({
    userId: '00000000-0000-4000-8000-00000000000a',
    handle: 'acme',
  }),
  getPublicStack: async () => null,
  publishPublicStackVersion: async () => {
    throw new Error('no network publish in this test');
  },
});

describe('public publish boundary (full preparation + serialization path)', () => {
  it('never emits project registry, bindings, legacy keys, Project IDs, or Memory', async () => {
    const { stackHome, memoryHash } = await seedPrivateMemoryState();
    const authoringStack = await seedAuthoringStack();

    // Gather every private token that MUST NOT leak into a public artifact.
    const registry = await readLocalRegistry(stackHome);
    const snapshot = await readPortableSnapshot(stackHome);
    const projectIds = registry.projects.map((r) => r.projectId);
    const legacyCompatKeys = (snapshot?.projects ?? []).flatMap((r) =>
      r.claims.filter((c) => c.type === 'legacy-compat').map((c) => c.key),
    );
    expect(projectIds.length).toBe(2);
    expect(legacyCompatKeys.length).toBe(1);

    const forbidden = [
      ...projectIds,
      ...legacyCompatKeys,
      SECRET_MEMORY,
      memoryHash,
      LEGACY_VENDOR_KEY,
      BINDING_DIR,
      'github.com/private-org/secret-repo',
      'projects-local',
      'snapshotVersion',
      'legacy-compat',
      'auto-memory',
      'bindings',
      'prj_',
    ];

    // Run the REAL preparation + serialization path (stops before any network).
    const plan = await preparePublish({
      stackHome,
      input: authoringStack,
      client: fakeClient(),
    });

    // Sanity: the pipeline really produced a public bundle for the authoring stack.
    expect(plan.bundle.requirements).toHaveLength(1);
    expect(plan.bundle.requirements[0]?.name).toBe('design');

    // The exact payload applyPublish would transmit over the wire.
    const publishPayload = {
      slug: plan.slug,
      displayName: plan.displayName,
      description: plan.description,
      bundle: plan.bundle,
      expectedLatestVersionId: plan.expectedLatestVersionId,
      idempotencyKey: '00000000-0000-4000-8000-0000000000ff',
    };

    const serialized = [
      JSON.stringify(plan.bundle),
      JSON.stringify(publishPayload),
      JSON.stringify(plan),
    ].join('\n');

    for (const token of forbidden)
      expect(serialized.includes(token)).toBe(false);
  });
});
