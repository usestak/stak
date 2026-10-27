import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readFile, writeFile as writeFileFs } from 'node:fs/promises';

import { hashSkillDirectory } from '@stack/shared';
import type { ScanResult, SkillSource } from '@stack/spec';
import { applyPush, initializeMainEnvironment, preparePush } from '@stack/core';
import {
  createCloudClient,
  SnapshotUploadFailedError,
} from '@stack/cloud-client';
import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  createInProcessFetch,
} from '@stack/cloud-server';
import { ingestSkill } from '@stack/store';

/**
 * Regression coverage for the content-upload gap: `cloud-bundle.ts` used to only include a
 * Skill in the upload set when its restoration strategy was already `snapshot`, so a
 * Git-backed Skill's bytes never reached STAK Cloud during `stak push`, breaking public
 * publication even after a successful push. These tests exercise the REAL `preparePush`/
 * `applyPush` pipeline against an in-memory Cloud service (via `createInProcessFetch`) — no
 * test here ever calls `blobStore.put` directly to fake a push.
 */

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-push-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const makeCloud = () => {
  const repository = createInMemoryRepository();
  const blobStore = createInMemoryBlobStore();
  const service = createCloudService({
    repository,
    blobStore,
    appUrl: 'http://localhost:3000',
    ticketSecret: 'push-content-upload-secret',
  });
  const fetchImpl = createInProcessFetch(service);
  const client = createCloudClient({
    baseUrl: 'http://localhost:3000',
    fetchImpl,
  });
  return { service, blobStore, client };
};

const signIn = async (
  service: ReturnType<typeof makeCloud>['service'],
  client: ReturnType<typeof makeCloud>['client'],
) => {
  const start = await client.authStart({});
  await service.approveCliAuth({
    userCode: start.userCode,
    profile: {
      userId: '00000000-0000-4000-8000-00000000aaaa',
      githubUsername: 'temi',
    },
  });
  const token = await client.authToken({ deviceSecret: start.deviceSecret });
  if (token.status !== 'approved') throw new Error('login failed');
  return token.token;
};

/** Seeds `main` with one local-only Skill and one Git-backed (clean, reference-eligible)
 *  Skill, so `buildCloudEnvironmentBundle` resolves one to `restoration.strategy ===
 *  'snapshot'` and the other to `'reference'`. */
const seedMainWithLocalAndGitSkills = async (
  stackHome: string,
  sourcesDir: string,
  gitMarker: string,
) => {
  const localDir = path.join(sourcesDir, 'local-skill');
  const gitDir = path.join(sourcesDir, 'git-skill');
  await mkdir(localDir, { recursive: true });
  await mkdir(gitDir, { recursive: true });
  await writeFile(
    path.join(localDir, 'SKILL.md'),
    '---\nname: local-skill\ndescription: local skill\n---\nlocal body\n',
  );
  await writeFile(
    path.join(gitDir, 'SKILL.md'),
    `---\nname: git-skill\ndescription: git skill\n---\n${gitMarker}\n`,
  );
  const localHash = (await hashSkillDirectory(localDir)).hash;
  const gitHash = (await hashSkillDirectory(gitDir)).hash;
  const gitSource: SkillSource = {
    type: 'git',
    remote: 'https://example.test/repo.git',
    revision: 'a'.repeat(40),
    path: 'skills/git-skill',
    clean: true,
  };
  const scanResult: ScanResult = {
    roots: [
      {
        path: sourcesDir,
        rootKind: 'agents',
        scope: 'global',
        status: 'scanned',
        skillLocations: 2,
      },
    ],
    skills: [
      {
        contentHash: localHash,
        metadata: { name: 'local-skill', description: 'local skill' },
        valid: true,
        source: { type: 'local' as const },
        locations: [
          {
            path: localDir,
            rootKind: 'agents' as const,
            scope: 'global' as const,
            rootPath: sourcesDir,
            isSymlink: false,
            realPath: localDir,
            source: { type: 'local' as const },
          },
        ],
      },
      {
        contentHash: gitHash,
        metadata: { name: 'git-skill', description: 'git skill' },
        valid: true,
        source: gitSource,
        locations: [
          {
            path: gitDir,
            rootKind: 'agents' as const,
            scope: 'global' as const,
            rootPath: sourcesDir,
            isSymlink: false,
            realPath: gitDir,
            source: gitSource,
          },
        ],
      },
    ],
    nameCollisions: [],
    diagnostics: [],
    summary: {
      roots: { scanned: 1, missing: 0, failed: 0 },
      uniqueSkillContents: 2,
      locations: 2,
      validSkills: 2,
      invalidSkills: 0,
      exactDuplicateContents: 0,
      nameCollisions: 0,
      diagnostics: { errors: 0, warnings: 0, info: 0 },
      provenance: { git: 1, local: 1, unknown: 0 },
    },
  };
  await initializeMainEnvironment({ stackHome, scanResult });
  return { localHash, gitHash };
};

/** Simulates "the owner approved a new revision" for the Git-backed `git-skill` entry: ingest
 *  new content into the local Store, then re-point the already-locked entry's `contentHash`
 *  (and reference `expectedContentHash`) at it in place — the push pipeline only cares about
 *  what main's lock currently approves, not how a scan/approve flow got it there. */
const bumpGitSkillContent = async (
  root: string,
  stackHome: string,
  marker: string,
): Promise<string> => {
  const dir = path.join(root, `git-skill-${marker}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: git-skill\ndescription: git skill\n---\n${marker}\n`,
  );
  const newHash = (await hashSkillDirectory(dir)).hash;
  await ingestSkill({
    stackHome,
    sourcePath: dir,
    expectedContentHash: newHash,
  });

  const lockPath = path.join(
    stackHome,
    'environments',
    'main',
    'stack.lock.json',
  );
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
    skills: Record<
      string,
      {
        name: string;
        contentHash: string;
        restoration: Record<string, unknown>;
      }
    >;
  };
  const entry = Object.values(lock.skills).find(
    (skill) => skill.name === 'git-skill',
  );
  if (!entry) throw new Error('git-skill entry missing from stack.lock.json');
  entry.contentHash = newHash;
  const reference = entry.restoration.reference as Record<string, unknown>;
  reference.expectedContentHash = newHash;
  await writeFileFs(lockPath, JSON.stringify(lock, null, 2));
  return newHash;
};

describe('stak push uploads immutable content for every resolved Skill', () => {
  it('uploads bytes for both a local-only Skill and a Git-backed Skill, which keeps its reference restoration', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const { blobStore, service, client } = makeCloud();
    const token = await signIn(service, client);
    const authedClient = createCloudClient({
      baseUrl: 'http://localhost:3000',
      token,
      fetchImpl: createInProcessFetch(service),
    });

    const { localHash, gitHash } = await seedMainWithLocalAndGitSkills(
      stackHome,
      path.join(root, 'src'),
      'v1',
    );

    const plan = await preparePush({ stackHome, client: authedClient });
    expect(plan.references).toBe(1);
    expect(plan.snapshotsToUpload.sort()).toEqual([gitHash, localHash].sort());

    const result = await applyPush({ stackHome, plan, client: authedClient });
    expect(result.uploaded).toBe(2);

    // Real server-side state, never seeded manually: both Skills' bytes are now actually
    // present in the owner's private blob store.
    const ownerId = '00000000-0000-4000-8000-00000000aaaa';
    expect(await blobStore.get(ownerId, localHash)).not.toBeNull();
    expect(await blobStore.get(ownerId, gitHash)).not.toBeNull();

    // The Git-backed Skill's private restoration metadata is untouched by the upload.
    const remote = await authedClient.getEnvironment('main');
    const gitSkill = Object.values(
      remote?.latest?.bundle.resolved.skills ?? {},
    ).find((skill) => skill.name === 'git-skill');
    expect(gitSkill?.restoration.strategy).toBe('reference');
  });

  it('deduplicates by content hash on a repeated push and re-uploads only a genuinely changed Git-backed Skill', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const { service, client } = makeCloud();
    const token = await signIn(service, client);
    const authedClient = createCloudClient({
      baseUrl: 'http://localhost:3000',
      token,
      fetchImpl: createInProcessFetch(service),
    });

    await seedMainWithLocalAndGitSkills(
      stackHome,
      path.join(root, 'src'),
      'v1',
    );
    const firstPlan = await preparePush({ stackHome, client: authedClient });
    await applyPush({ stackHome, plan: firstPlan, client: authedClient });

    // Nothing changed: a second push plan is a no-op.
    const noopPlan = await preparePush({ stackHome, client: authedClient });
    expect(noopPlan.noop).toBe(true);

    // Change the Git-backed Skill's content: new hash, re-approve in place, re-push.
    const newGitHash = await bumpGitSkillContent(root, stackHome, 'v2');
    const secondPlan = await preparePush({ stackHome, client: authedClient });
    expect(secondPlan.noop).toBe(false);
    expect(secondPlan.snapshotsToUpload).toEqual([newGitHash]);
    // The local-only Skill's unchanged content is already present server-side.
    expect(secondPlan.snapshotsAlready).toBe(1);

    const secondResult = await applyPush({
      stackHome,
      plan: secondPlan,
      client: authedClient,
    });
    expect(secondResult.uploaded).toBe(1);
  });

  it('fails the push cleanly when a Skill exceeds the snapshot size limit, uploading nothing', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const { blobStore, service, client } = makeCloud();
    const token = await signIn(service, client);
    const authedClient = createCloudClient({
      baseUrl: 'http://localhost:3000',
      token,
      fetchImpl: createInProcessFetch(service),
    });

    const { localHash, gitHash } = await seedMainWithLocalAndGitSkills(
      stackHome,
      path.join(root, 'src'),
      'v1',
    );

    await expect(
      preparePush({ stackHome, client: authedClient, maxSnapshotBytes: 1 }),
    ).rejects.toBeInstanceOf(SnapshotUploadFailedError);

    const ownerId = '00000000-0000-4000-8000-00000000aaaa';
    expect(await blobStore.get(ownerId, localHash)).toBeNull();
    expect(await blobStore.get(ownerId, gitHash)).toBeNull();
  });
});

describe('web-originated single-Skill share after a real stak push', () => {
  const OWNER = {
    userId: '00000000-0000-4000-8000-00000000aaaa',
    tokenId: 'test',
  };

  it('a Git-backed Skill shares successfully through its immutable snapshot once real push has uploaded its bytes', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const { service, client } = makeCloud();
    const token = await signIn(service, client);
    const authedClient = createCloudClient({
      baseUrl: 'http://localhost:3000',
      token,
      fetchImpl: createInProcessFetch(service),
    });

    const { gitHash } = await seedMainWithLocalAndGitSkills(
      stackHome,
      path.join(root, 'src'),
      'v1',
    );
    const plan = await preparePush({ stackHome, client: authedClient });
    await applyPush({ stackHome, plan, client: authedClient });

    const gitSkillId = Object.entries(plan.bundle.resolved.skills).find(
      ([, skill]) => skill.name === 'git-skill',
    )?.[0];
    if (!gitSkillId)
      throw new Error('git-skill entry missing from pushed bundle');

    // This is the "web" surface: skill-share-service's own methods, not the CLI publish path.
    const before = await service.getSkillShareStatus(OWNER, gitSkillId);
    expect(before.share.status).toBe('shareable');

    const shared = await service.shareSkill(OWNER, {
      skillId: gitSkillId,
      slug: 'git-skill',
    });
    const published = await service.getPublicStack('temi', 'git-skill');
    expect(published?.latest?.bundle.requirements[0]?.restoration).toEqual({
      strategy: 'snapshot',
      contentHash: gitHash,
    });

    // The owner's PRIVATE restoration for this same Skill is still Git-reference — the
    // public share never mutated local semantics.
    const remote = await authedClient.getEnvironment('main');
    const gitSkill = remote?.latest?.bundle.resolved.skills[gitSkillId];
    expect(gitSkill?.restoration.strategy).toBe('reference');

    const afterShare = await service.getSkillShareStatus(OWNER, gitSkillId);
    expect(afterShare.share.status).toBe('already-shared');
    expect(shared.owner).toBe('temi');
  });

  it('web share is blocked cleanly before any push — the Skill is unknown to Cloud, not just "upload-required"', async () => {
    // Unlike skill-share-service.test.ts's "committed-but-unseeded" fixtures (which simulate
    // a main environment version that reached Cloud through SOME path without its bytes —
    // the historical/legacy failure mode this whole fix targets), a real `stak push` is
    // atomic: `applyPush` never commits `main` to Cloud without first uploading every Skill's
    // content. So without any push at all, `main` was never committed server-side, and the
    // web path must fail closed on "no such Skill", never silently falling back to anything.
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const { service, client } = makeCloud();
    await signIn(service, client);
    await seedMainWithLocalAndGitSkills(
      stackHome,
      path.join(root, 'src'),
      'v1',
    );

    await expect(
      service.getSkillShareStatus(OWNER, 'skill_whatever01'),
    ).rejects.toMatchObject({ code: 'skill-not-found' });
    await expect(
      service.getPublicStack('temi', 'git-skill'),
    ).rejects.toMatchObject({ code: 'public-stack-not-found' });
  });
});

describe('stak push round trips', () => {
  /** Counts Cloud API calls by route so tests can assert on round trips, not just results. */
  const countingClient = (
    service: ReturnType<typeof makeCloud>['service'],
    token: string,
  ) => {
    const calls: string[] = [];
    const inner = createInProcessFetch(service);
    const client = createCloudClient({
      baseUrl: 'http://localhost:3000',
      token,
      fetchImpl: (input, init) => {
        const route = new URL(input).pathname
          .replace('/api/v1/', '')
          .replace(/sha256:[0-9a-f]+|[0-9a-f-]{36}|up\.[^/]+/g, ':id');
        calls.push(`${init.method} ${route.split('/').slice(0, 2).join('/')}`);
        return inner(input, init);
      },
    });
    return { client, calls };
  };

  it('reuses the plan-time upload ticket instead of preparing each snapshot twice', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const { service, client } = makeCloud();
    const token = await signIn(service, client);
    const { client: counted, calls } = countingClient(service, token);
    await seedMainWithLocalAndGitSkills(
      stackHome,
      path.join(root, 'src'),
      'v1',
    );

    const plan = await preparePush({ stackHome, client: counted });
    calls.length = 0;
    const result = await applyPush({ stackHome, plan, client: counted });

    expect(result.uploaded).toBe(2);
    expect(calls.filter((c) => c === 'POST snapshots/prepare')).toHaveLength(0);
  });

  it('re-prepares when the plan-time ticket is too old to trust', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const { service, client } = makeCloud();
    const token = await signIn(service, client);
    const { client: counted, calls } = countingClient(service, token);
    await seedMainWithLocalAndGitSkills(
      stackHome,
      path.join(root, 'src'),
      'v1',
    );

    let now = 1_000_000;
    const plan = await preparePush({
      stackHome,
      client: counted,
      nowMs: () => now,
    });
    now += 6 * 60 * 1000;
    calls.length = 0;
    const result = await applyPush({
      stackHome,
      plan,
      client: counted,
      nowMs: () => now,
    });

    expect(result.uploaded).toBe(2);
    expect(calls.filter((c) => c === 'POST snapshots/prepare')).toHaveLength(2);
  });

  it('only checks content that is new since this Machine last pushed', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const { service, client } = makeCloud();
    const token = await signIn(service, client);
    const { client: counted, calls } = countingClient(service, token);
    const { localHash } = await seedMainWithLocalAndGitSkills(
      stackHome,
      path.join(root, 'src'),
      'v1',
    );
    await applyPush({
      stackHome,
      plan: await preparePush({ stackHome, client: counted }),
      client: counted,
    });

    const newHash = await bumpGitSkillContent(root, stackHome, 'v2');
    calls.length = 0;
    const plan = await preparePush({ stackHome, client: counted });

    // The unchanged local Skill was confirmed by the previous push; only the new
    // content costs a Cloud round trip.
    expect(calls.filter((c) => c === 'POST snapshots/prepare')).toHaveLength(1);
    expect(plan.snapshotsToUpload).toEqual([newHash]);
    expect(plan.snapshotsAlready).toBe(1);
    expect(plan.snapshotsToUpload).not.toContain(localHash);
  });

  it('re-checks everything when Cloud moved on since this Machine last synced', async () => {
    const root = await temp();
    const stackHome = path.join(root, 'stack');
    const { service, client } = makeCloud();
    const token = await signIn(service, client);
    const { client: counted, calls } = countingClient(service, token);
    await seedMainWithLocalAndGitSkills(
      stackHome,
      path.join(root, 'src'),
      'v1',
    );
    await applyPush({
      stackHome,
      plan: await preparePush({ stackHome, client: counted }),
      client: counted,
    });

    // A pull (or older CLI) rewrites sync state without confirmed hashes.
    const syncDir = path.join(stackHome, 'state', 'machines');
    const [machineId] = await (
      await import('node:fs/promises')
    ).readdir(syncDir);
    const syncFile = path.join(syncDir, machineId as string, 'sync.json');
    const sync = JSON.parse(await readFile(syncFile, 'utf8'));
    delete sync.environments.main.confirmedContentHashes;
    await writeFileFs(syncFile, JSON.stringify(sync));

    await bumpGitSkillContent(root, stackHome, 'v2');
    calls.length = 0;
    await preparePush({ stackHome, client: counted });
    expect(calls.filter((c) => c === 'POST snapshots/prepare')).toHaveLength(2);
  });
});
