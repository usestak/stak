import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashSkillDirectory } from '@stack/shared';
import type { ResolvedLocalEnvironment, ScanResult } from '@stack/spec';
import {
  applyStackUse,
  buildCloudEnvironmentBundle,
  initializeMainEnvironment,
  loadMainEnvironment,
  prepareStackRemove,
  prepareStackUse,
} from '@stack/core';
import { createCloudClient } from '@stack/cloud-client';
import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  createInProcessFetch,
  type CloudService,
} from '@stack/cloud-server';
import { verifyStoredSkill } from '@stack/store';

import type { CredentialStore, StoredCredential } from './cloud/credentials.js';
import {
  cloudApplyPull,
  cloudApplyPush,
  cloudPreparePull,
  cloudPreparePush,
  performLogin,
  type CloudOperationsDeps,
} from './cloud/operations.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-cloud-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const USER_A = '00000000-0000-4000-8000-00000000aaaa';
const USER_B = '00000000-0000-4000-8000-00000000bbbb';

const makeCloud = () => {
  const repository = createInMemoryRepository();
  const blobStore = createInMemoryBlobStore();
  const service = createCloudService({
    repository,
    blobStore,
    appUrl: 'http://localhost:3000',
    ticketSecret: 'roundtrip-secret',
  });
  const fetchImpl = createInProcessFetch(service);
  const createClient = (options: { baseUrl: string; token?: string }) =>
    createCloudClient({
      baseUrl: options.baseUrl,
      ...(options.token ? { token: options.token } : {}),
      fetchImpl,
    });
  return { service, repository, blobStore, createClient };
};

const inMemoryCredentials = (): CredentialStore => {
  let credential: StoredCredential | null = null;
  return {
    read: async () => credential,
    write: async (value) => {
      credential = value;
    },
    clear: async () => {
      credential = null;
    },
  };
};

const seedSkill = async (dir: string, name: string, body: string) => {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`,
  );
  return (await hashSkillDirectory(dir)).hash;
};

const buildMain = async (
  stackHome: string,
  sourcesDir: string,
  names: string[],
) => {
  const seeded: { name: string; dir: string; hash: string }[] = [];
  for (const name of names) {
    const dir = path.join(sourcesDir, name);
    seeded.push({ name, dir, hash: await seedSkill(dir, name, `${name} v1`) });
  }
  const scanResult: ScanResult = {
    roots: [
      {
        path: sourcesDir,
        rootKind: 'agents',
        scope: 'global',
        status: 'scanned',
        skillLocations: seeded.length,
      },
    ],
    skills: seeded.map((item) => ({
      contentHash: item.hash,
      metadata: { name: item.name, description: `${item.name} skill` },
      valid: true,
      source: { type: 'local' as const },
      locations: [
        {
          path: item.dir,
          rootKind: 'agents' as const,
          scope: 'global' as const,
          rootPath: sourcesDir,
          isSymlink: false,
          realPath: item.dir,
          source: { type: 'local' as const },
        },
      ],
    })),
    nameCollisions: [],
    diagnostics: [],
    summary: {
      roots: { scanned: 1, missing: 0, failed: 0 },
      uniqueSkillContents: seeded.length,
      locations: seeded.length,
      validSkills: seeded.length,
      invalidSkills: 0,
      exactDuplicateContents: 0,
      nameCollisions: 0,
      diagnostics: { errors: 0, warnings: 0, info: 0 },
      provenance: { git: 0, local: seeded.length, unknown: 0 },
    },
  };
  await initializeMainEnvironment({ stackHome, scanResult });
  return seeded;
};

const seedStackLayer = async (
  stackHome: string,
  stackDir: string,
  stackName: string,
  skillName: string,
) => {
  await mkdir(path.join(stackDir, 'skills', skillName), { recursive: true });
  await writeFile(
    path.join(stackDir, 'stack.yaml'),
    `schemaVersion: 1\nname: ${stackName}\ndescription: ${stackName} stack\nskills:\n  - path: skills/${skillName}\n    requirement: required\n`,
  );
  await writeFile(
    path.join(stackDir, 'skills', skillName, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: ${skillName} skill\n---\n${skillName} body\n`,
  );
  const proposal = await prepareStackUse({ stackHome, input: stackDir });
  await applyStackUse(proposal);
};

const makeDeps = (
  stackHome: string,
  credentials: CredentialStore,
  createClient: CloudOperationsDeps['createClient'],
): CloudOperationsDeps => ({
  stackHome,
  env: { STACK_API_URL: 'http://localhost' },
  credentials,
  writeOut: () => {},
  ...(createClient ? { createClient } : {}),
  sleep: async () => {},
});

const loginAs = async (
  service: CloudService,
  deps: CloudOperationsDeps,
  userId: string,
  github: string,
) =>
  performLogin(
    {
      ...deps,
      openBrowser: async (url: string) => {
        const code = new URL(url).searchParams.get('code');
        if (code)
          await service.approveCliAuth({
            userCode: code,
            profile: { userId, githubUsername: github },
          });
      },
    },
    {},
  );

describe('cross-machine cloud portability', () => {
  it('reconstructs the same portable main on a fresh Machine', async () => {
    const root = await temp();
    const { service, createClient } = makeCloud();

    // --- Machine A ---
    const stackHomeA = path.join(root, 'a-stack');
    const credsA = inMemoryCredentials();
    const depsA = makeDeps(stackHomeA, credsA, createClient);
    await buildMain(stackHomeA, path.join(root, 'a-src'), ['foo', 'bar']);
    await seedStackLayer(
      stackHomeA,
      path.join(root, 'a-frontend'),
      'frontend',
      'design',
    );
    await loginAs(service, depsA, USER_A, 'alice');

    const pushPlan = await cloudPreparePush(depsA);
    expect(pushPlan.conflict).toBeNull();
    expect(pushPlan.remoteExists).toBe(false);
    expect(pushPlan.snapshotsToUpload.length).toBeGreaterThan(0);
    const pushResult = await cloudApplyPush(depsA, pushPlan);
    expect(pushResult.versionNumber).toBe(1);
    expect(pushResult.createdNew).toBe(true);

    const bundleA = await buildCloudEnvironmentBundle({
      stackHome: stackHomeA,
    });
    const stateA = await loadMainEnvironment({ stackHome: stackHomeA });

    // --- Machine B (fresh) ---
    const stackHomeB = path.join(root, 'b-stack');
    const credsB = inMemoryCredentials();
    const depsB = makeDeps(stackHomeB, credsB, createClient);
    await loginAs(service, depsB, USER_A, 'alice');

    await expect(
      loadMainEnvironment({ stackHome: stackHomeB }),
    ).rejects.toThrow();

    const pullPlan = await cloudPreparePull(depsB);
    expect(pullPlan.mode).toBe('create');
    expect(pullPlan.conflict).toBeNull();
    const pullResult = await cloudApplyPull(depsB, pullPlan);
    expect(pullResult.status).toBe('restored');

    const bundleB = await buildCloudEnvironmentBundle({
      stackHome: stackHomeB,
    });
    const stateB = await loadMainEnvironment({ stackHome: stackHomeB });

    // Same portable Environment digest and logical identity.
    expect(bundleB.digest).toBe(bundleA.digest);
    expect(stateB.manifest.skills).toEqual(stateA.manifest.skills);
    expect(stateB.manifest.stacks).toEqual(stateA.manifest.stacks);

    // Same Skill content hashes verified in Machine B's Store.
    for (const [entryId, skill] of Object.entries(stateA.lock.skills)) {
      expect(stateB.lock.skills[entryId]?.contentHash).toBe(skill.contentHash);
      expect(
        (
          await verifyStoredSkill({
            stackHome: stackHomeB,
            contentHash: skill.contentHash,
          })
        ).state,
      ).toBe('available');
    }

    // Local snapshot ids are freshly generated for Machine B.
    for (const [entryId, skill] of Object.entries(stateA.lock.skills))
      if (skill.restoration.strategy === 'snapshot') {
        const restored = stateB.lock.skills[entryId]?.restoration;
        expect(restored?.strategy).toBe('snapshot');
        if (restored?.strategy === 'snapshot')
          expect(restored.snapshotId).not.toBe(skill.restoration.snapshotId);
      }

    // Machine identity differs; Machine A baseline placements are not imported.
    expect(stateB.machine.machineId).not.toBe(stateA.machine.machineId);
    for (const entry of Object.values(stateB.baseline.skills))
      expect(entry.locations).toEqual([]);

    // No agent binding registry was imported from Machine A.
    await expect(
      stat(
        path.join(
          stackHomeB,
          'state',
          'machines',
          stateB.machine.machineId,
          'bindings.json',
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    // Imported Stack layers survive: stack remove still resolves on Machine B.
    const removal = await prepareStackRemove({
      stackHome: stackHomeB,
      identifier: 'frontend',
    });
    expect(removal.layer.name).toBe('frontend');

    // A resolved environment can be projected by an adapter later.
    const resolved: ResolvedLocalEnvironment = {
      name: stateB.manifest.name,
      machineId: stateB.machine.machineId,
      skills: Object.entries(stateB.lock.skills).map(([entryId, locked]) => ({
        entryId,
        name: locked.name,
        contentHash: locked.contentHash,
      })),
    };
    expect(resolved.skills.length).toBe(Object.keys(stateA.lock.skills).length);
  });

  it('reports a no-op push when nothing changed', async () => {
    const root = await temp();
    const { service, createClient } = makeCloud();
    const stackHome = path.join(root, 'stack');
    const deps = makeDeps(stackHome, inMemoryCredentials(), createClient);
    await buildMain(stackHome, path.join(root, 'src'), ['foo']);
    await loginAs(service, deps, USER_A, 'alice');
    await cloudApplyPush(deps, await cloudPreparePush(deps));
    const second = await cloudPreparePush(deps);
    expect(second.noop).toBe(true);
  });

  it('blocks a stale push with a remote conflict when another Machine advanced', async () => {
    const root = await temp();
    const { service, createClient } = makeCloud();
    // Machine A pushes v1.
    const stackHomeA = path.join(root, 'a');
    const depsA = makeDeps(stackHomeA, inMemoryCredentials(), createClient);
    await buildMain(stackHomeA, path.join(root, 'a-src'), ['foo']);
    await loginAs(service, depsA, USER_A, 'alice');
    await cloudApplyPush(depsA, await cloudPreparePush(depsA));

    // Machine B pulls v1, then A pushes v2.
    const stackHomeB = path.join(root, 'b');
    const depsB = makeDeps(stackHomeB, inMemoryCredentials(), createClient);
    await loginAs(service, depsB, USER_A, 'alice');
    await cloudApplyPull(depsB, await cloudPreparePull(depsB));

    await seedStackLayer(
      stackHomeA,
      path.join(root, 'a-fe'),
      'frontend',
      'design',
    );
    await cloudApplyPush(depsA, await cloudPreparePush(depsA));

    // Machine B changes locally and tries to push against a stale base.
    await seedStackLayer(stackHomeB, path.join(root, 'b-fe'), 'backend', 'api');
    const plan = await cloudPreparePush(depsB);
    expect(plan.conflict?.kind).toBe('remote-newer');

    // With no local change, Machine B can pull v2 cleanly.
    const stackHomeC = path.join(root, 'c');
    const depsC = makeDeps(stackHomeC, inMemoryCredentials(), createClient);
    await loginAs(service, depsC, USER_A, 'alice');
    const pull = await cloudApplyPull(depsC, await cloudPreparePull(depsC));
    expect(pull.status).toBe('restored');
  });

  it('blocks pull when local main has unsynced changes', async () => {
    const root = await temp();
    const { service, createClient } = makeCloud();
    const stackHomeA = path.join(root, 'a');
    const depsA = makeDeps(stackHomeA, inMemoryCredentials(), createClient);
    await buildMain(stackHomeA, path.join(root, 'a-src'), ['foo']);
    await loginAs(service, depsA, USER_A, 'alice');
    await cloudApplyPush(depsA, await cloudPreparePush(depsA));
    await seedStackLayer(
      stackHomeA,
      path.join(root, 'a-fe'),
      'frontend',
      'design',
    );
    await cloudApplyPush(depsA, await cloudPreparePush(depsA));

    // Machine B pulls v2, then edits locally and a newer v3 exists remotely.
    const stackHomeB = path.join(root, 'b');
    const depsB = makeDeps(stackHomeB, inMemoryCredentials(), createClient);
    await loginAs(service, depsB, USER_A, 'alice');
    await cloudApplyPull(depsB, await cloudPreparePull(depsB));
    await seedStackLayer(stackHomeB, path.join(root, 'b-fe'), 'backend', 'api');
    await seedStackLayer(
      stackHomeA,
      path.join(root, 'a-be'),
      'backend',
      'api2',
    );
    await cloudApplyPush(depsA, await cloudPreparePush(depsA));

    const plan = await cloudPreparePull(depsB);
    expect(plan.conflict?.kind).toBe('local-changes');
  });

  it('refuses to overwrite an unsynced local main that collides with cloud', async () => {
    const root = await temp();
    const { service, createClient } = makeCloud();
    const stackHomeA = path.join(root, 'a');
    const depsA = makeDeps(stackHomeA, inMemoryCredentials(), createClient);
    await buildMain(stackHomeA, path.join(root, 'a-src'), ['foo']);
    await loginAs(service, depsA, USER_A, 'alice');
    await cloudApplyPush(depsA, await cloudPreparePush(depsA));

    // Machine B has its own local main but has never synced with the cloud.
    const stackHomeB = path.join(root, 'b');
    const depsB = makeDeps(stackHomeB, inMemoryCredentials(), createClient);
    await buildMain(stackHomeB, path.join(root, 'b-src'), ['foo']);
    await loginAs(service, depsB, USER_A, 'alice');

    const pullPlan = await cloudPreparePull(depsB);
    expect(pullPlan.conflict?.kind).toBe('unsynced-local');
    const pushPlan = await cloudPreparePush(depsB);
    expect(pushPlan.conflict?.kind).toBe('unsynced-remote');
  });

  it('deduplicates identical snapshot content across versions', async () => {
    const root = await temp();
    const { service, createClient, repository } = makeCloud();
    const stackHome = path.join(root, 'a');
    const deps = makeDeps(stackHome, inMemoryCredentials(), createClient);
    await buildMain(stackHome, path.join(root, 'src'), ['foo']);
    await loginAs(service, deps, USER_A, 'alice');
    await cloudApplyPush(deps, await cloudPreparePush(deps));
    // A second version that adds a layer but keeps foo's content.
    await seedStackLayer(
      stackHome,
      path.join(root, 'fe'),
      'frontend',
      'design',
    );
    await cloudApplyPush(deps, await cloudPreparePush(deps));
    // foo's content hash is stored exactly once for this user.
    const fooHashes = [...repository.snapshots.values()].filter(
      (snapshot) => snapshot.userId === USER_A,
    );
    const unique = new Set(fooHashes.map((snapshot) => snapshot.contentHash));
    expect(unique.size).toBe(fooHashes.length);
  });

  it('keeps User A snapshots unreachable by User B', async () => {
    const root = await temp();
    const { service, createClient } = makeCloud();
    const stackHomeA = path.join(root, 'a');
    const depsA = makeDeps(stackHomeA, inMemoryCredentials(), createClient);
    const seeded = await buildMain(stackHomeA, path.join(root, 'a-src'), [
      'foo',
    ]);
    await loginAs(service, depsA, USER_A, 'alice');
    await cloudApplyPush(depsA, await cloudPreparePush(depsA));

    const credsB = inMemoryCredentials();
    const depsB = makeDeps(path.join(root, 'b'), credsB, createClient);
    await loginAs(service, depsB, USER_B, 'bob');
    const credentialB = await credsB.read();
    const clientB = createClient({
      baseUrl: 'http://localhost',
      ...(credentialB ? { token: credentialB.token } : {}),
    });
    const targetHash = seeded[0]?.hash ?? '';
    await expect(clientB.downloadSnapshot(targetHash)).rejects.toThrow();
  });
});
