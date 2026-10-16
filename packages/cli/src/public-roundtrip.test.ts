import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  hashSkillDirectory,
  hashSkillTreeEntries,
  sha256CanonicalJson,
} from '@stack/shared';
import type { SkillTreeEntry } from '@stack/shared';
import type { ImportedStackVersion, SkillSource } from '@stack/spec';
import {
  applyRemoteStackUse,
  buildPublicStackBundle,
  initializeMainEnvironment,
  loadMainEnvironment,
  prepareRemoteStackUse,
  prepareStackRemove,
  preserveRemoteTrialStack,
  resolvePublicStackSource,
  resolveRemoteTrialStack,
  type GitExecutor,
} from '@stack/core';
import { createCloudClient } from '@stack/cloud-client';
import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  createInProcessFetch,
} from '@stack/cloud-server';
import {
  ingestSkill,
  packSkillTreeEntries,
  packStoreObject,
  verifyStoredSkill,
} from '@stack/store';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-public-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const USER_A = '00000000-0000-4000-8000-00000000aaaa';
const REMOTE = 'https://example.com/example/design.git';
const REVISION = 'a'.repeat(40);
const SKILL_PATH = 'skills/design';

const makeCloud = () => {
  const repository = createInMemoryRepository();
  const blobStore = createInMemoryBlobStore();
  const service = createCloudService({
    repository,
    blobStore,
    appUrl: 'http://localhost:3000',
    ticketSecret: 'public-secret',
  });
  const fetchImpl = createInProcessFetch(service);
  const createClient = (options: { baseUrl: string; token?: string }) =>
    createCloudClient({
      baseUrl: options.baseUrl,
      ...(options.token ? { token: options.token } : {}),
      fetchImpl,
    });
  return { service, blobStore, createClient };
};

const mintToken = async (
  service: ReturnType<typeof createCloudService>,
  createClient: (o: {
    baseUrl: string;
    token?: string;
  }) => ReturnType<typeof createCloudClient>,
): Promise<string> => {
  const anon = createClient({ baseUrl: 'http://localhost' });
  const start = await anon.authStart({});
  await service.approveCliAuth({
    userCode: start.userCode,
    profile: { userId: USER_A, githubUsername: 'alice' },
  });
  const token = await anon.authToken({ deviceSecret: start.deviceSecret });
  if (token.status !== 'approved') throw new Error('login failed');
  return token.token;
};

const gitSource = (): SkillSource => ({
  type: 'git',
  remote: REMOTE,
  revision: REVISION,
  path: SKILL_PATH,
  clean: true,
});

const referenceVersion = (contentHash: string): ImportedStackVersion => {
  const requirements = [
    {
      id: 'req_design01',
      name: 'design',
      requirement: 'required' as const,
      contentHash,
      metadata: { name: 'design', description: 'Design engineering' },
      restoration: {
        strategy: 'reference' as const,
        reference: {
          remote: REMOTE,
          revision: REVISION,
          path: SKILL_PATH,
          expectedContentHash: contentHash,
        },
      },
      observedSources: [gitSource()],
      preferredSource: gitSource(),
      originStackName: 'frontend',
    },
  ];
  return {
    schemaVersion: 1,
    name: 'frontend',
    description: 'Frontend Stack',
    versionHash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    requirements,
    inheritedStacks: [],
    skippedOptional: [],
  };
};

const skillBody = (marker: string) =>
  `---\nname: design\ndescription: Design engineering\n---\n${marker}\n`;

const hashOfBody = async (root: string, marker: string) => {
  const dir = path.join(root, `content-${marker}`, 'design');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), skillBody(marker));
  return (await hashSkillDirectory(dir)).hash;
};

const multiSnapshotVersion = (
  skills: { skillId: string; name: string; contentHash: string }[],
): ImportedStackVersion => ({
  schemaVersion: 1,
  name: 'local-stack',
  description: 'All-local Stack',
  versionHash:
    'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  requirements: skills.map(({ skillId, name, contentHash }) => ({
    id: `req_${skillId}`,
    name,
    requirement: 'required' as const,
    contentHash,
    metadata: { name, description: `${name} description` },
    // Local-only placeholder restoration — never dereferenced downstream (see
    // `publicBundleToImportedVersion`'s comment); `buildPublicStackBundle` reads the
    // requirement's own top-level `contentHash`, not anything inside `restoration`.
    restoration: {
      strategy: 'snapshot' as const,
      snapshotId: `snap_${skillId}`,
      reason: 'local' as const,
    },
    observedSources: [],
    originStackName: 'local-stack',
  })),
  inheritedStacks: [],
  skippedOptional: [],
});

const snapshotVersion = (
  skillId: string,
  name: string,
  contentHash: string,
): ImportedStackVersion =>
  multiSnapshotVersion([{ skillId, name, contentHash }]);

/**
 * Simulate `stak push`: ingest a real directory into the OWNER's own local Store, pack it
 * into the exact transport-archive bytes the real push flow would upload, then seed those
 * bytes directly into the owner-scoped Cloud blob store (bypassing the HTTP upload-ticket
 * dance, which isn't what this test is verifying).
 */
const pushLocalSkill = async (
  ownerStackHome: string,
  blobStore: ReturnType<typeof createInMemoryBlobStore>,
  marker: string,
): Promise<string> => {
  const sourceDir = path.join(ownerStackHome, `source-${marker}`);
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, 'SKILL.md'), skillBody(marker));
  const expectedContentHash = (await hashSkillDirectory(sourceDir)).hash;
  const { contentHash } = await ingestSkill({
    stackHome: ownerStackHome,
    sourcePath: sourceDir,
    expectedContentHash,
  });
  const { bytes } = await packStoreObject({
    stackHome: ownerStackHome,
    contentHash,
  });
  await blobStore.put(USER_A, contentHash, bytes);
  return contentHash;
};

const fakeGit =
  (marker: string): GitExecutor =>
  async (args, { cwd }) => {
    if (args[0] === 'checkout') {
      const dest = path.join(cwd, ...SKILL_PATH.split('/'));
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, 'SKILL.md'), skillBody(marker));
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

const publish = async (
  cloud: ReturnType<typeof makeCloud>,
  token: string,
  contentHash: string,
) => {
  const bundle = buildPublicStackBundle(referenceVersion(contentHash));
  const client = cloud.createClient({ baseUrl: 'http://localhost', token });
  const existing = await client.getPublicStack('alice', 'frontend');
  return client.publishPublicStackVersion('frontend', {
    slug: 'frontend',
    bundle,
    expectedLatestVersionId: existing?.latest?.version.versionId ?? null,
  });
};

const publishVersion = async (
  cloud: ReturnType<typeof makeCloud>,
  token: string,
  slug: string,
  version: ImportedStackVersion,
) => {
  const bundle = buildPublicStackBundle(version);
  const client = cloud.createClient({ baseUrl: 'http://localhost', token });
  const existing = await client.getPublicStack('alice', slug);
  return client.publishPublicStackVersion(slug, {
    slug,
    bundle,
    expectedLatestVersionId: existing?.latest?.version.versionId ?? null,
  });
};

describe('public Stack consumption', () => {
  it('publishes and reads anonymously', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    // Snapshot-first publication: even this Git-backed Skill's content must already be in
    // Cloud (equivalent to `stak push`) before it can publish.
    const contentHash = await pushLocalSkill(root, cloud.blobStore, 'v1');
    const result = await publish(cloud, token, contentHash);
    expect(result.owner).toBe('alice');

    const anon = cloud.createClient({ baseUrl: 'http://localhost' });
    const read = await anon.getPublicStack('alice', 'frontend');
    expect(read?.latest?.bundle.requirements[0]?.name).toBe('design');
    // The published restoration is the immutable snapshot, not a Git reference — proof this
    // Git-backed Skill no longer depends on its repository remaining reachable.
    expect(read?.latest?.bundle.requirements[0]?.restoration).toEqual({
      strategy: 'snapshot',
      contentHash,
    });
  });

  it('reconstructs a public Stack into main and stays offline afterward, with zero Git fetch for a Git-backed Skill', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    const contentHash = await pushLocalSkill(root, cloud.blobStore, 'v1');
    await publish(cloud, token, contentHash);

    const stackHome = path.join(root, 'consumer');
    await initializeMainEnvironment({
      stackHome,
      scanResult: emptyScan(),
    });
    const anon = cloud.createClient({ baseUrl: 'http://localhost' });
    const source = await resolvePublicStackSource({
      client: anon,
      ref: '@alice/frontend',
    });

    // Dry-run style prepare must not mutate the Store or main.
    const proposal = await prepareRemoteStackUse({ stackHome, source });
    expect((await verifyStoredSkill({ stackHome, contentHash })).state).toBe(
      'missing',
    );

    // No `gitExecutor` passed at all — this is the central reproducibility guarantee: a
    // published STAK is self-contained. The ORIGINAL source was Git-backed, but the published
    // (snapshot) restoration never touches Git; only the public snapshot fetch (`client`) is
    // needed to resolve it.
    await applyRemoteStackUse(proposal, { client: anon });
    const state = await loadMainEnvironment({ stackHome });
    const layer = state.manifest.stacks[0];
    expect(layer?.source?.kind).toBe('public');
    expect((await verifyStoredSkill({ stackHome, contentHash })).state).toBe(
      'available',
    );
    // Requirement origins retained in the lock.
    const locked = Object.values(state.lock.skills)[0];
    expect(locked?.origins?.some((o) => o.type === 'stack')).toBe(true);

    // Offline: remove resolves without any cloud client.
    const removal = await prepareStackRemove({
      stackHome,
      identifier: 'frontend',
    });
    expect(removal.layer.name).toBe('frontend');
  });

  it('leaves main unchanged when a public snapshot fails its integrity check', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    const contentHash = await pushLocalSkill(root, cloud.blobStore, 'v1');
    await publish(cloud, token, contentHash);

    // Simulate corrupted/compromised storage: the bytes served for this exact published
    // contentHash no longer match it (`ensurePublicSnapshotUploaded` trusts the caller's
    // content-addressing at publish time — it never re-verifies bytes against the hash), so
    // the CONSUMER-side extraction integrity check is what must hold the line. Since this
    // requirement never touches Git at all now, this replaces the old "Git checkout returned
    // the wrong content" scenario with the equivalent one for the snapshot path.
    const tamperedEntries: SkillTreeEntry[] = [
      {
        relativePath: 'SKILL.md',
        type: 'file',
        content: Buffer.from(skillBody('tampered')),
      },
    ];
    const tampered = packSkillTreeEntries(tamperedEntries);
    await cloud.blobStore.putPublished(contentHash, tampered.bytes);

    const stackHome = path.join(root, 'consumer');
    await initializeMainEnvironment({ stackHome, scanResult: emptyScan() });
    const anon = cloud.createClient({ baseUrl: 'http://localhost' });
    const source = await resolvePublicStackSource({
      client: anon,
      ref: '@alice/frontend',
    });
    const proposal = await prepareRemoteStackUse({ stackHome, source });
    // Wrong content -> hash mismatch -> abort before persisting the layer.
    await expect(
      applyRemoteStackUse(proposal, { client: anon }),
    ).rejects.toThrow();
    const state = await loadMainEnvironment({ stackHome });
    expect(state.manifest.stacks).toHaveLength(0);
  });

  it('does not silently update an already-active public Stack', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    await publish(
      cloud,
      token,
      await pushLocalSkill(root, cloud.blobStore, 'v1'),
    );

    const stackHome = path.join(root, 'consumer');
    await initializeMainEnvironment({ stackHome, scanResult: emptyScan() });
    const anon = cloud.createClient({ baseUrl: 'http://localhost' });
    const v1 = await resolvePublicStackSource({
      client: anon,
      ref: '@alice/frontend',
    });
    await applyRemoteStackUse(
      await prepareRemoteStackUse({ stackHome, source: v1 }),
      { client: anon },
    );

    // Publish v2 (different content) and attempt to use it again.
    await publish(
      cloud,
      token,
      await pushLocalSkill(root, cloud.blobStore, 'v2'),
    );
    const v2 = await resolvePublicStackSource({
      client: anon,
      ref: '@alice/frontend',
    });
    await expect(
      prepareRemoteStackUse({ stackHome, source: v2 }),
    ).rejects.toThrow(/already active/i);
  });

  it('runs a remote trial that acquires content without a main, with no Git fetch for a Git-backed Skill', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    const contentHash = await pushLocalSkill(root, cloud.blobStore, 'v1');
    await publish(cloud, token, contentHash);

    const stackHome = path.join(root, 'trial-machine');
    const anon = cloud.createClient({ baseUrl: 'http://localhost' });
    const trial = await resolveRemoteTrialStack({
      client: anon,
      ref: '@alice/frontend',
    });
    expect(trial.kind).toBe('public');
    // No `gitExecutor` — same reproducibility guarantee as the `use` path above.
    await preserveRemoteTrialStack({
      stackHome,
      trial,
      client: anon,
    });
    expect((await verifyStoredSkill({ stackHome, contentHash })).state).toBe(
      'available',
    );
    // No main was created by the trial.
    await expect(
      stat(path.join(stackHome, 'environments', 'main')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('legacy reference-only published bundles still resolve through the Git/reference path, unaffected by snapshot-first publication', async () => {
    // A bundle shaped exactly like a row published before snapshot-first publication existed
    // — built by hand, never through `buildPublicStackBundle` (which no longer emits this
    // shape) — simulating a real pre-existing row read back from Cloud storage.
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    const publisher = cloud.createClient({
      baseUrl: 'http://localhost',
      token,
    });

    const legacyContentHash = await hashOfBody(root, 'legacy');
    const legacyBundle = {
      schemaVersion: 1 as const,
      stack: {
        name: 'legacy-frontend',
        description: 'Legacy Frontend Stack',
        versionHash: `sha256:${'0'.repeat(64)}`,
        kind: 'stack' as const,
      },
      requirements: [
        {
          id: 'req_legacy01',
          name: 'design',
          requirement: 'required' as const,
          contentHash: legacyContentHash,
          metadata: { name: 'design', description: 'Design engineering' },
          restoration: {
            strategy: 'reference' as const,
            reference: {
              remote: REMOTE,
              revision: REVISION,
              path: SKILL_PATH,
              expectedContentHash: legacyContentHash,
            },
          },
          observedSources: [gitSource()],
          preferredSource: gitSource(),
          originStackName: 'legacy-frontend',
        },
      ],
      inheritedStackMetadata: [],
    };
    const digestInput = {
      stack: legacyBundle.stack,
      requirements: legacyBundle.requirements,
      inheritedStackMetadata: legacyBundle.inheritedStackMetadata,
    };
    const versionHash = sha256CanonicalJson({
      name: legacyBundle.stack.name,
      description: legacyBundle.stack.description,
      requirements: legacyBundle.requirements,
      inheritedStacks: legacyBundle.inheritedStackMetadata,
      skippedOptional: [],
    });
    const finalBundle = {
      ...legacyBundle,
      stack: { ...legacyBundle.stack, versionHash },
      digest: sha256CanonicalJson({
        ...digestInput,
        stack: { ...legacyBundle.stack, versionHash },
      }),
    };
    await publisher.publishPublicStackVersion('legacy-frontend', {
      slug: 'legacy-frontend',
      bundle: finalBundle,
      expectedLatestVersionId: null,
    });

    const stackHome = path.join(root, 'legacy-consumer');
    await initializeMainEnvironment({ stackHome, scanResult: emptyScan() });
    const anon = cloud.createClient({ baseUrl: 'http://localhost' });
    const source = await resolvePublicStackSource({
      client: anon,
      ref: '@alice/legacy-frontend',
    });
    const restoration = source.restorations.get('req_legacy01');
    expect(restoration?.strategy).toBe('reference');
    const proposal = await prepareRemoteStackUse({ stackHome, source });
    // No `client` passed — the legacy reference path never needs one; it resolves purely
    // through Git.
    await applyRemoteStackUse(proposal, { gitExecutor: fakeGit('legacy') });
    expect(
      (await verifyStoredSkill({ stackHome, contentHash: legacyContentHash }))
        .state,
    ).toBe('available');
  });

  it('Hybrid Public Skill Portability: an all-local (zero-Git) named Stack with 3 snapshot-backed Skills publishes and is fully consumable anonymously, with no Git source required', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    const ownerHome = path.join(root, 'owner');

    const hashA = await pushLocalSkill(ownerHome, cloud.blobStore, 'local-a');
    const hashB = await pushLocalSkill(ownerHome, cloud.blobStore, 'local-b');
    const hashC = await pushLocalSkill(ownerHome, cloud.blobStore, 'local-c');
    const version = multiSnapshotVersion([
      { skillId: 'local_a00', name: 'local-skill-a', contentHash: hashA },
      { skillId: 'local_b00', name: 'local-skill-b', contentHash: hashB },
      { skillId: 'local_c00', name: 'local-skill-c', contentHash: hashC },
    ]);
    const published = await publishVersion(
      cloud,
      token,
      'local-stack',
      version,
    );
    expect(published.createdNew).toBe(true);

    // Anonymous (unauthenticated) consumer — no token anywhere below.
    const anon = cloud.createClient({ baseUrl: 'http://localhost' });
    const read = await anon.getPublicStack('alice', 'local-stack');
    expect(read?.latest?.bundle.requirements).toHaveLength(3);
    for (const requirement of read?.latest?.bundle.requirements ?? [])
      expect(requirement.restoration).toEqual({
        strategy: 'snapshot',
        contentHash: requirement.contentHash,
      });

    const stackHome = path.join(root, 'consumer');
    await initializeMainEnvironment({ stackHome, scanResult: emptyScan() });
    const source = await resolvePublicStackSource({
      client: anon,
      ref: '@alice/local-stack',
    });
    const proposal = await prepareRemoteStackUse({ stackHome, source });
    // No gitExecutor passed at all — proves no Git source is ever required.
    await applyRemoteStackUse(proposal, { client: anon });

    for (const hash of [hashA, hashB, hashC])
      expect(
        (await verifyStoredSkill({ stackHome, contentHash: hash })).state,
      ).toBe('available');
    const state = await loadMainEnvironment({ stackHome });
    expect(state.manifest.stacks[0]?.source?.kind).toBe('public');
  });

  it('Hybrid Public Skill Portability: version immutability — V1 keeps retrieving its own snapshot after V2 republishes different content', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    const ownerHome = path.join(root, 'owner');

    const hashA = await pushLocalSkill(ownerHome, cloud.blobStore, 'immut-a');
    const v1 = await publishVersion(
      cloud,
      token,
      'notes',
      snapshotVersion('notes0001', 'notes', hashA),
    );
    const hashB = await pushLocalSkill(ownerHome, cloud.blobStore, 'immut-b');
    const v2 = await publishVersion(
      cloud,
      token,
      'notes',
      snapshotVersion('notes0001', 'notes', hashB),
    );
    expect(v2.version.versionNumber).toBe(v1.version.versionNumber + 1);

    const anon = cloud.createClient({ baseUrl: 'http://localhost' });
    const v1Bytes = await anon.getPublicSkillSnapshot(
      'alice',
      'notes',
      v1.version.versionNumber,
      hashA,
    );
    const v2Bytes = await anon.getPublicSkillSnapshot(
      'alice',
      'notes',
      v2.version.versionNumber,
      hashB,
    );
    expect(new TextDecoder().decode(v1Bytes)).not.toBe(
      new TextDecoder().decode(v2Bytes),
    );
    // V1's hash is not part of V2's own bundle — consuming V2 by its hash never returns A,
    // and A does not get silently overwritten by B under the same content-addressed key.
    await expect(
      anon.getPublicSkillSnapshot(
        'alice',
        'notes',
        v2.version.versionNumber,
        hashA,
      ),
    ).rejects.toThrow();
    // `@owner/slug` without a version pin resolves to the CURRENT (latest) publication.
    const current = await anon.getPublicStack('alice', 'notes');
    expect(current?.latest?.version.versionNumber).toBe(
      v2.version.versionNumber,
    );
    expect(current?.latest?.bundle.requirements[0]?.contentHash).toBe(hashB);
  });

  it('Hybrid Public Skill Portability: a symlink entry inside a public snapshot that targets outside the tree is rejected, not installed, even when its content hash matches perfectly', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);

    // Craft a malicious archive directly (not through `ingestSkill`, which enforces safety
    // on normal local ingestion) — simulates untrusted bytes reaching the public namespace
    // (compromised storage, a server bug) so the CONSUMER-side extraction is what must hold
    // the line, not just the owner's own push path.
    const maliciousEntries: SkillTreeEntry[] = [
      {
        relativePath: 'SKILL.md',
        type: 'file',
        content: Buffer.from(skillBody('evil')),
      },
      { relativePath: 'escape', type: 'symlink', target: '../../../outside' },
    ];
    const maliciousHash = hashSkillTreeEntries(maliciousEntries);
    const malicious = packSkillTreeEntries(maliciousEntries);
    // Seed the OWNER-scoped store directly with the malicious bytes under their own real
    // hash, so `ensurePublicSnapshotUploaded` (server-side) finds real "pushed" bytes and
    // copies them into the public namespace at publish time — exactly the real flow.
    await cloud.blobStore.put(USER_A, maliciousHash, malicious.bytes);
    await publishVersion(
      cloud,
      token,
      'evil-stack',
      snapshotVersion('evil00001', 'evil-skill', maliciousHash),
    );

    const stackHome = path.join(root, 'consumer');
    await initializeMainEnvironment({ stackHome, scanResult: emptyScan() });
    const anon = cloud.createClient({ baseUrl: 'http://localhost' });
    const source = await resolvePublicStackSource({
      client: anon,
      ref: '@alice/evil-stack',
    });
    const proposal = await prepareRemoteStackUse({ stackHome, source });
    await expect(
      applyRemoteStackUse(proposal, { client: anon }),
    ).rejects.toThrow();
    expect(
      (await verifyStoredSkill({ stackHome, contentHash: maliciousHash }))
        .state,
    ).toBe('missing');
    const state = await loadMainEnvironment({ stackHome });
    expect(state.manifest.stacks).toHaveLength(0);
    // The escape target was never written outside the Store/stackHome root.
    await expect(stat(path.join(root, 'outside'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

const emptyScan = () => ({
  roots: [
    {
      path: '/tmp/none',
      rootKind: 'agents' as const,
      scope: 'global' as const,
      status: 'scanned' as const,
      skillLocations: 0,
    },
  ],
  skills: [],
  nameCollisions: [],
  diagnostics: [],
  summary: {
    roots: { scanned: 1, missing: 0, failed: 0 },
    uniqueSkillContents: 0,
    locations: 0,
    validSkills: 0,
    invalidSkills: 0,
    exactDuplicateContents: 0,
    nameCollisions: 0,
    diagnostics: { errors: 0, warnings: 0, info: 0 },
    provenance: { git: 0, local: 0, unknown: 0 },
  },
});
