import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashSkillDirectory } from '@stack/shared';
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
import { verifyStoredSkill } from '@stack/store';

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
  const service = createCloudService({
    repository,
    blobStore: createInMemoryBlobStore(),
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
  return { service, createClient };
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

describe('public Stack consumption', () => {
  it('publishes and reads anonymously', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    const contentHash = await hashOfBody(root, 'v1');
    const result = await publish(cloud, token, contentHash);
    expect(result.owner).toBe('alice');

    const anon = cloud.createClient({ baseUrl: 'http://localhost' });
    const read = await anon.getPublicStack('alice', 'frontend');
    expect(read?.latest?.bundle.requirements[0]?.name).toBe('design');
  });

  it('reconstructs a public Stack into main and stays offline afterward', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    const contentHash = await hashOfBody(root, 'v1');
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

    await applyRemoteStackUse(proposal, { gitExecutor: fakeGit('v1') });
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

  it('leaves main unchanged when a reference cannot be verified', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    const contentHash = await hashOfBody(root, 'v1');
    await publish(cloud, token, contentHash);

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
      applyRemoteStackUse(proposal, { gitExecutor: fakeGit('tampered') }),
    ).rejects.toThrow();
    const state = await loadMainEnvironment({ stackHome });
    expect(state.manifest.stacks).toHaveLength(0);
  });

  it('does not silently update an already-active public Stack', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    await publish(cloud, token, await hashOfBody(root, 'v1'));

    const stackHome = path.join(root, 'consumer');
    await initializeMainEnvironment({ stackHome, scanResult: emptyScan() });
    const anon = cloud.createClient({ baseUrl: 'http://localhost' });
    const v1 = await resolvePublicStackSource({
      client: anon,
      ref: '@alice/frontend',
    });
    await applyRemoteStackUse(
      await prepareRemoteStackUse({ stackHome, source: v1 }),
      {
        gitExecutor: fakeGit('v1'),
      },
    );

    // Publish v2 (different content) and attempt to use it again.
    await publish(cloud, token, await hashOfBody(root, 'v2'));
    const v2 = await resolvePublicStackSource({
      client: anon,
      ref: '@alice/frontend',
    });
    await expect(
      prepareRemoteStackUse({ stackHome, source: v2 }),
    ).rejects.toThrow(/already active/i);
  });

  it('runs a remote trial that acquires content without a main', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    const contentHash = await hashOfBody(root, 'v1');
    await publish(cloud, token, contentHash);

    const stackHome = path.join(root, 'trial-machine');
    const anon = cloud.createClient({ baseUrl: 'http://localhost' });
    const trial = await resolveRemoteTrialStack({
      client: anon,
      ref: '@alice/frontend',
    });
    expect(trial.kind).toBe('public');
    await preserveRemoteTrialStack({
      stackHome,
      trial,
      gitExecutor: fakeGit('v1'),
    });
    expect((await verifyStoredSkill({ stackHome, contentHash })).state).toBe(
      'available',
    );
    // No main was created by the trial.
    await expect(
      stat(path.join(stackHome, 'environments', 'main')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
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
