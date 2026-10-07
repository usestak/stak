import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  resolvePublicStackSource,
  spawnGit,
} from '@stack/core';
import { createCloudClient } from '@stack/cloud-client';
import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  createInProcessFetch,
} from '@stack/cloud-server';

import type { CredentialStore, StoredCredential } from './cloud/credentials.js';
import {
  cloudApplyPush,
  cloudPreparePush,
  type CloudOperationsDeps,
} from './cloud/operations.js';
import { runSkillCheck } from './skill-check-runner.js';

/**
 * P5a final micro-gate §3 — direct regression proving the public-stack audit finding (a Skill
 * imported via `stak use <stack>` carries its requirement's `restoration` field VERBATIM, see
 * packages/core/src/public-stack.ts) holds end-to-end: synthetic public Stack -> `stak use` ->
 * resulting locked Skill -> restoration reference preserved -> `stak skill check` -> exact
 * candidate materialized -> normalized source-check/review result. This is NOT a new
 * public-stack architecture and exercises `runSkillCheck` completely unmodified, with zero
 * Cloud public-stack special-casing: the only "fakery" is a git `url.<x>.insteadOf` rewrite (a
 * standard, real Git feature, configured via GIT_CONFIG_GLOBAL) so the Stack's necessarily-
 * portable-format (https://) remote resolves to a real local Git repository instead of the
 * network, letting every Git operation below (fetch, checkout, ls-remote) run for real.
 */

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-public-check-'));
  roots.push(root);
  return root;
};

const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
afterEach(async () => {
  if (originalGitConfigGlobal === undefined)
    delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

const USER_A = '00000000-0000-4000-8000-00000000aaaa';
const DUMMY_REMOTE = 'https://example.com/example/design.git';
const SKILL_PATH = 'design';

const runGit = async (cwd: string, args: string[]) => {
  const result = await spawnGit(args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result;
};

const skillBody = (marker: string) =>
  `---\nname: design\ndescription: Design engineering\n---\n${marker}\n`;

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
  return { service, repository, createClient };
};

const mintToken = async (
  cloud: ReturnType<typeof makeCloud>,
): Promise<string> => {
  const anon = cloud.createClient({ baseUrl: 'http://localhost' });
  const start = await anon.authStart({});
  await cloud.service.approveCliAuth({
    userCode: start.userCode,
    profile: { userId: USER_A, githubUsername: 'alice' },
  });
  const token = await anon.authToken({ deviceSecret: start.deviceSecret });
  if (token.status !== 'approved') throw new Error('login failed');
  return token.token;
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

const gitSource = (revision: string): SkillSource => ({
  type: 'git',
  remote: DUMMY_REMOTE,
  revision,
  path: SKILL_PATH,
  clean: true,
});

const referenceVersion = (
  contentHash: string,
  revision: string,
): ImportedStackVersion => {
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
          remote: DUMMY_REMOTE,
          revision,
          path: SKILL_PATH,
          expectedContentHash: contentHash,
          // SOURCE LOCATOR: tracked ref, required for `stak skill check` to re-resolve
          // an update at all (an exact-commit-pinned reference with no `ref` is 'pinned').
          ref: 'refs/heads/main',
        },
      },
      observedSources: [gitSource(revision)],
      preferredSource: gitSource(revision),
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

describe('public Stack -> stak use -> stak skill check (direct regression, no special-casing)', () => {
  it('materializes the exact candidate and reports a normalized update for a public-stack-originated Skill', async () => {
    const root = await temp();

    // A real local Git repository stands in for the Stack's upstream remote. The Stack bundle
    // itself must carry a portable-format (https://) remote (enforced by referenceRecordSchema,
    // both at publish time and inside restoreReference) — a real `url.insteadOf` rewrite (a
    // standard Git feature, not a STAK-specific shim) transparently redirects that dummy remote
    // to this real repo for every Git operation below, so fetch/checkout/ls-remote all run for
    // real with zero code-path substitution.
    const repoDir = path.join(root, 'origin-repo');
    await runGit(root, ['init', '-q', repoDir]);
    await runGit(repoDir, ['checkout', '-q', '-b', 'main']);
    await runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    await runGit(repoDir, ['config', 'user.name', 'Test']);
    const skillDir = path.join(repoDir, SKILL_PATH);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), skillBody('v1'));
    await runGit(repoDir, ['add', '.']);
    await runGit(repoDir, ['commit', '-q', '-m', 'v1']);
    const revisionV1 = (
      await runGit(repoDir, ['rev-parse', 'HEAD'])
    ).stdout.trim();
    const contentHash = (await hashSkillDirectory(skillDir)).hash;

    const gitConfigPath = path.join(root, 'gitconfig-insteadof');
    const repoDirPosix = repoDir.split(path.sep).join('/');
    await writeFile(
      gitConfigPath,
      // autocrlf=false: a real `git checkout` (unlike materializeExactRevision, which already
      // pins this per-invocation) would otherwise rewrite this fixture's LF line endings to
      // CRLF under a machine-global autocrlf=true, producing a spurious content-hash mismatch
      // unrelated to anything this test is actually checking.
      `[core]\n\tautocrlf = false\n[url "${repoDirPosix}"]\n\tinsteadOf = ${DUMMY_REMOTE}\n`,
    );
    process.env.GIT_CONFIG_GLOBAL = gitConfigPath;

    const cloud = makeCloud();
    const token = await mintToken(cloud);
    const bundle = buildPublicStackBundle(
      referenceVersion(contentHash, revisionV1),
    );
    const publisher = cloud.createClient({
      baseUrl: 'http://localhost',
      token,
    });
    await publisher.publishPublicStackVersion('frontend', {
      slug: 'frontend',
      bundle,
      expectedLatestVersionId: null,
    });

    // --- `stak use @alice/frontend` ---
    const stackHome = path.join(root, 'consumer');
    await initializeMainEnvironment({ stackHome, scanResult: emptyScan() });
    const anon = cloud.createClient({ baseUrl: 'http://localhost' });
    const source = await resolvePublicStackSource({
      client: anon,
      ref: '@alice/frontend',
    });
    const proposal = await prepareRemoteStackUse({ stackHome, source });
    // Real restoreReference underneath: real `git fetch`/`checkout` (redirected to repoDir by
    // the insteadOf rule), real content-hash verification against expectedContentHash.
    await applyRemoteStackUse(proposal);

    const state = await loadMainEnvironment({ stackHome });
    const [entryId, locked] = Object.entries(state.lock.skills)[0] ?? [];
    if (!entryId || !locked)
      throw new Error('Skill was not locked by stak use');

    // Restoration reference preserved VERBATIM — this is the audited contract
    // (packages/core/src/public-stack.ts): no public-stack-native restoration strategy exists.
    expect(locked.restoration).toEqual({
      strategy: 'reference',
      reference: {
        remote: DUMMY_REMOTE,
        revision: revisionV1,
        path: SKILL_PATH,
        expectedContentHash: contentHash,
        ref: 'refs/heads/main',
      },
    });
    expect(locked.origins?.some((o) => o.type === 'stack')).toBe(true);

    // `stak push` — the Skill must exist on Cloud (tied to a pushed Environment) before
    // `stak skill check` can report against it, exactly like any other Skill.
    const credentials = inMemoryCredentials();
    await credentials.write({
      schemaVersion: 1,
      token,
      createdAt: new Date().toISOString(),
    });
    const deps: CloudOperationsDeps = {
      stackHome,
      env: { STACK_API_URL: 'http://localhost' },
      credentials,
      writeOut: () => {},
      createClient: cloud.createClient,
      sleep: async () => {},
    };
    const pushPlan = await cloudPreparePush(deps);
    await cloudApplyPush(deps, pushPlan);

    // Upstream moves: a second commit lands on the same tracked ref.
    await writeFile(path.join(skillDir, 'SKILL.md'), skillBody('v2'));
    await runGit(repoDir, ['add', '.']);
    await runGit(repoDir, ['commit', '-q', '-m', 'v2']);
    const revisionV2 = (
      await runGit(repoDir, ['rev-parse', 'HEAD'])
    ).stdout.trim();
    const candidateContentHash = (await hashSkillDirectory(skillDir)).hash;

    // --- `stak skill check` — the literal, unmodified CLI entrypoint. No injected git
    // executor, no mocked Cloud: real network-shaped Git calls (redirected only by the
    // standard insteadOf rule above) and a real in-process Cloud round trip. ---
    const workRoot = path.join(root, 'work');
    const reporter = cloud.createClient({ baseUrl: 'http://localhost', token });
    const result = await runSkillCheck({
      lock: state.lock,
      workRoot,
      reporter,
    });

    expect(result.checked).toEqual([
      {
        entryId,
        name: 'design',
        outcome: 'update-available',
        exceedsBounds: false,
        candidateRevision: revisionV2,
        reviewArtifactId: expect.any(String),
      },
    ]);

    // Stored exactly like any other Git-sourced Skill's check — no public-stack special
    // casing anywhere in the stored record.
    const stored = await cloud.repository.getSkillReviewCheck(USER_A, entryId);
    expect(stored).toMatchObject({
      userId: USER_A,
      skillId: entryId,
      approvedContentHash: contentHash,
      sourceCheckState: 'update-available',
      candidateRevision: revisionV2,
      candidateContentHash,
    });
    expect(stored?.reviewArtifactId).toBe(result.checked[0]?.reviewArtifactId);
  });
});
