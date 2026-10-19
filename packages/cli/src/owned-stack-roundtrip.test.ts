import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashSkillDirectory } from '@stack/shared';
import type { CloudEnvironmentBundle } from '@stack/spec';
import {
  applyOwnedStackUse,
  initializeMainEnvironment,
  loadMainEnvironment,
  prepareOwnedStackUse,
  resolveOwnedStackSource,
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
  const root = await mkdtemp(path.join(tmpdir(), 'stack-owned-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const USER_A = '00000000-0000-4000-8000-00000000bbbb';
const REMOTE = 'https://example.com/example/design.git';
const REVISION = 'a'.repeat(40);
const SKILL_PATH = 'skills/design';
const SKILL_ID = 'skill_design0001';

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

const makeCloud = () => {
  const repository = createInMemoryRepository();
  const service = createCloudService({
    repository,
    blobStore: createInMemoryBlobStore(),
    appUrl: 'http://localhost:3000',
    ticketSecret: 'owned-stack-secret',
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
  createClient: ReturnType<typeof makeCloud>['createClient'],
  userId: string = USER_A,
  githubUsername: string = 'alice',
): Promise<string> => {
  const anon = createClient({ baseUrl: 'http://localhost' });
  const start = await anon.authStart({});
  await service.approveCliAuth({
    userCode: start.userCode,
    profile: { userId, githubUsername },
  });
  const token = await anon.authToken({ deviceSecret: start.deviceSecret });
  if (token.status !== 'approved') throw new Error('login failed');
  return token.token;
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

/** Pushes a private `main` bundle with one Git-reference-backed approved Skill — the data
 *  `createUserStack` reads to build a named Stack's bundle. */
const pushMainWithSkill = async (
  service: ReturnType<typeof createCloudService>,
  contentHash: string,
) => {
  const bundle: CloudEnvironmentBundle = {
    schemaVersion: 1,
    environment: {
      schemaVersion: 1,
      name: 'main',
      skills: [{ id: SKILL_ID, name: 'design', requirement: 'required' }],
      stacks: [],
      overrides: {},
    },
    resolved: {
      schemaVersion: 1,
      skills: {
        [SKILL_ID]: {
          name: 'design',
          description: 'Design engineering',
          contentHash,
          metadata: { name: 'design', description: 'Design engineering' },
          observedSources: [],
          restoration: {
            strategy: 'reference',
            reference: {
              remote: REMOTE,
              revision: REVISION,
              path: SKILL_PATH,
              expectedContentHash: contentHash,
            },
          },
        },
      },
    },
    importedStackVersions: [],
    contentUploadRequirements: [],
    digest: `sha256:${'0'.repeat(64)}`,
  };
  await service.commitEnvironmentVersion(
    { userId: USER_A, tokenId: 'test' },
    'main',
    { bundle, expectedLatestVersionId: null },
  );
};

describe('owned named Stack — `stak use <name>` (P10B §14)', () => {
  it('creates a named Stack from approved Skills and applies it on another machine', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    const contentHash = await hashOfBody(root, 'v1');
    await pushMainWithSkill(cloud.service, contentHash);

    const auth = { userId: USER_A, tokenId: 'test' };
    const created = await cloud.service.createUserStack(auth, {
      name: 'frontend',
      description: 'Frontend tools',
      skillIds: [SKILL_ID],
    });
    expect(created.name).toBe('frontend');

    const stackHome = path.join(root, 'consumer');
    await initializeMainEnvironment({ stackHome, scanResult: emptyScan() });
    const authed = cloud.createClient({ baseUrl: 'http://localhost', token });
    const source = await resolveOwnedStackSource({
      client: authed,
      name: 'frontend',
    });
    expect(source.version.requirements).toHaveLength(1);

    const proposal = await prepareOwnedStackUse({ stackHome, source });
    expect((await verifyStoredSkill({ stackHome, contentHash })).state).toBe(
      'missing',
    );

    await applyOwnedStackUse(proposal, { gitExecutor: fakeGit('v1') });
    const state = await loadMainEnvironment({ stackHome });
    const layer = state.manifest.stacks[0];
    expect(layer?.source?.kind).toBe('owned');
    expect((await verifyStoredSkill({ stackHome, contentHash })).state).toBe(
      'available',
    );
  });

  it("refuses to resolve another account's named Stack", async () => {
    const root = await temp();
    const cloud = makeCloud();
    await mintToken(cloud.service, cloud.createClient);
    const contentHash = await hashOfBody(root, 'v1');
    await pushMainWithSkill(cloud.service, contentHash);
    await cloud.service.createUserStack(
      { userId: USER_A, tokenId: 'test' },
      { name: 'frontend', skillIds: [SKILL_ID] },
    );

    const USER_B = '00000000-0000-4000-8000-00000000cccc';
    const otherToken = await mintToken(
      cloud.service,
      cloud.createClient,
      USER_B,
      'bob',
    );

    const authedAsOther = cloud.createClient({
      baseUrl: 'http://localhost',
      token: otherToken,
    });
    const result = await authedAsOther.getUserStack('frontend');
    expect(result).toBeNull();
  });

  it('404 (no such owned Stack) resolves to an honest "not found" error', async () => {
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    const authed = cloud.createClient({ baseUrl: 'http://localhost', token });
    await expect(
      resolveOwnedStackSource({ client: authed, name: 'nonexistent' }),
    ).rejects.toMatchObject({ code: 'owned-stack-not-found' });
  });

  it('a network/auth failure is never relabeled as "not found" (spec P10 correction §10)', async () => {
    // A stub client simulating connectivity/auth failure — NOT the 404 "no such Stack" case
    // `getUserStack` itself returns `null` for. `resolveOwnedStackSource` must propagate this
    // exactly as thrown, never translate it into the misleading "No Cloud Stack named..."
    // message a genuine 404 gets.
    const networkFailure = new Error('fetch failed: ENOTFOUND');
    const failingClient = {
      getUserStack: async () => {
        throw networkFailure;
      },
    };
    await expect(
      resolveOwnedStackSource({ client: failingClient, name: 'frontend' }),
    ).rejects.toBe(networkFailure);
  });

  it('does not silently update an already-active owned Stack', async () => {
    const root = await temp();
    const cloud = makeCloud();
    const token = await mintToken(cloud.service, cloud.createClient);
    const contentHash = await hashOfBody(root, 'v1');
    await pushMainWithSkill(cloud.service, contentHash);
    await cloud.service.createUserStack(
      { userId: USER_A, tokenId: 'test' },
      { name: 'frontend', skillIds: [SKILL_ID] },
    );

    const stackHome = path.join(root, 'consumer');
    await initializeMainEnvironment({ stackHome, scanResult: emptyScan() });
    const authed = cloud.createClient({ baseUrl: 'http://localhost', token });
    const source = await resolveOwnedStackSource({
      client: authed,
      name: 'frontend',
    });
    const proposal = await prepareOwnedStackUse({ stackHome, source });
    await applyOwnedStackUse(proposal, { gitExecutor: fakeGit('v1') });

    const again = await resolveOwnedStackSource({
      client: authed,
      name: 'frontend',
    });
    await expect(
      prepareOwnedStackUse({ stackHome, source: again }),
    ).rejects.toThrow(/already active/);
  });
});
