// Phase 9 controlled public-ecosystem demonstration.
//
// Fenced under a Phase 6.1 owned temporary root. A publisher creates a clean
// Git-reference-backed local Stack, publishes it to an in-process Stack Cloud,
// and a separate consumer Machine tries and uses @user-a/frontend. Publishing
// requires the owner's pushed snapshot, so the consumer reacquires the exact
// Skill from the published public snapshot; an injected Git executor stands in
// for the published remote (a portable https URL that is intentionally
// unreachable offline). It never writes to the real user HOME.

import { execFileSync } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

import { createCloudClient } from '../packages/cloud-client/dist/index.js';
import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  createInProcessFetch,
} from '../packages/cloud-server/dist/index.js';
import {
  applyPublish,
  applyPush,
  applyRemoteStackUse,
  initializeMainEnvironment,
  loadMainEnvironment,
  prepareRemoteStackUse,
  preparePublish,
  preparePush,
  prepareStackRemove,
  preserveRemoteTrialStack,
  resolvePublicStackSource,
  resolveRemoteTrialStack,
} from '../packages/core/dist/index.js';
import {
  createOwnedTestRoot,
  hashSkillDirectory,
} from '../packages/shared/dist/index.js';
import {
  ingestSkill,
  packStoreObject,
  verifyStoredSkill,
} from '../packages/store/dist/index.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const missing = async (target) => {
  try {
    await stat(target);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
};

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const REMOTE = 'https://example.com/example/design.git';
const SKILL_PATH = 'skills/design';
const DESIGN_BODY =
  '---\nname: design\ndescription: Design engineering\n---\ndesign body\n';

const owned = await createOwnedTestRoot('stack-phase9-demo-');
console.log(`Owned temporary root: ${owned.rootPath}`);

try {
  const repository = createInMemoryRepository();
  const blobStore = createInMemoryBlobStore();
  const service = createCloudService({
    repository,
    blobStore,
    appUrl: 'http://localhost:3000',
    ticketSecret: 'phase9-demo-secret',
  });
  const fetchImpl = createInProcessFetch(service);
  const clientFor = (token) =>
    createCloudClient({
      baseUrl: 'http://localhost',
      ...(token ? { token } : {}),
      fetchImpl,
    });
  const mintToken = async (userId, github) => {
    const start = await service.startCliAuth({});
    await service.approveCliAuth({
      userCode: start.userCode,
      profile: { userId, githubUsername: github },
    });
    const result = await service.pollCliToken(start.deviceSecret);
    if (result.status !== 'approved') throw new Error('login failed');
    return result.token;
  };

  // --- Publisher: a clean Git-reference-backed local Stack -----------------
  const authoring = path.join(owned.rootPath, 'authoring');
  await owned.writeText(
    path.join(authoring, 'stak.yaml'),
    'schemaVersion: 1\nname: frontend\ndescription: Frontend Stack\nskills:\n  - path: skills/design\n    requirement: required\n',
  );
  await owned.writeText(
    path.join(authoring, SKILL_PATH, 'SKILL.md'),
    DESIGN_BODY,
  );
  const git = (args) =>
    execFileSync('git', args, { cwd: authoring, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 'demo@example.com']);
  git(['config', 'user.name', 'Stack Demo']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
  git(['remote', 'add', 'origin', REMOTE]);

  const contentHash = (
    await hashSkillDirectory(path.join(authoring, SKILL_PATH))
  ).hash;

  // Publishing requires the owner to have already pushed this exact content to
  // Cloud (Hybrid Public Skill Portability). Stand in for that `stak push`: pack
  // the Skill into the same transport archive a push uploads and seed it into
  // the owner's Cloud blob store (the upload-ticket round-trip is not what this
  // demo exercises).
  const uploadStackHome = path.join(owned.rootPath, 'publisher-upload');
  await ingestSkill({
    stackHome: uploadStackHome,
    sourcePath: path.join(authoring, SKILL_PATH),
    expectedContentHash: contentHash,
  });
  const { bytes: uploaded } = await packStoreObject({
    stackHome: uploadStackHome,
    contentHash,
  });
  await blobStore.put(USER_A, contentHash, uploaded);

  const publisherStackHome = path.join(owned.rootPath, 'publisher-stack');
  const tokenA = await mintToken(USER_A, 'alice');
  const publishPlan = await preparePublish({
    stackHome: publisherStackHome,
    input: authoring,
    client: clientFor(tokenA),
  });
  assert(!publishPlan.noop, 'First publish should not be a no-op.');
  assert(
    publishPlan.sourceRemotes.includes(REMOTE),
    'Publish preview should disclose the public source remote.',
  );
  const published = await applyPublish({
    plan: publishPlan,
    client: clientFor(tokenA),
  });
  assert(
    published.owner === 'alice',
    'Owner handle derived from GitHub login.',
  );
  assert(published.version.versionNumber === 1, 'First public version is v1.');
  console.log(
    `Published @${published.owner}/${published.slug} v${published.version.versionNumber}.`,
  );

  // Anonymous consumer can read public metadata (no token).
  const anon = clientFor(undefined);
  const publicRead = await anon.getPublicStack('alice', 'frontend');
  assert(
    publicRead?.latest?.bundle.requirements.length === 1,
    'Anonymous public read should succeed.',
  );
  const profile = await anon.getPublicProfile('alice');
  assert(
    profile?.stacks.some((s) => s.slug === 'frontend'),
    'Public profile lists the Stack.',
  );

  // --- Publisher also has a PRIVATE Environment with a snapshot ------------
  const privSource = path.join(owned.rootPath, 'private-src', 'secret');
  await owned.writeText(
    path.join(privSource, 'SKILL.md'),
    '---\nname: secret\ndescription: private\n---\nprivate body\n',
  );
  const privHash = (await hashSkillDirectory(privSource)).hash;
  await initializeMainEnvironment({
    stackHome: publisherStackHome,
    scanResult: {
      roots: [
        {
          path: path.dirname(privSource),
          rootKind: 'agents',
          scope: 'global',
          status: 'scanned',
          skillLocations: 1,
        },
      ],
      skills: [
        {
          contentHash: privHash,
          metadata: { name: 'secret', description: 'private' },
          valid: true,
          source: { type: 'local' },
          locations: [
            {
              path: privSource,
              rootKind: 'agents',
              scope: 'global',
              rootPath: path.dirname(privSource),
              isSymlink: false,
              realPath: privSource,
              source: { type: 'local' },
            },
          ],
        },
      ],
      nameCollisions: [],
      diagnostics: [],
      summary: {
        roots: { scanned: 1, missing: 0, failed: 0 },
        uniqueSkillContents: 1,
        locations: 1,
        validSkills: 1,
        invalidSkills: 0,
        exactDuplicateContents: 0,
        nameCollisions: 0,
        diagnostics: { errors: 0, warnings: 0, info: 0 },
        provenance: { git: 0, local: 1, unknown: 0 },
      },
    },
  });
  const pushPlan = await preparePush({
    stackHome: publisherStackHome,
    client: clientFor(tokenA),
  });
  await applyPush({
    stackHome: publisherStackHome,
    plan: pushPlan,
    client: clientFor(tokenA),
  });

  // --- Injected reacquisition (portable remote is unreachable offline) -----
  const fakeGit = async (args, { cwd }) => {
    if (args[0] === 'checkout') {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const dest = path.join(cwd, ...SKILL_PATH.split('/'));
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, 'SKILL.md'), DESIGN_BODY);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  // --- Consumer: remote trial without a main -------------------------------
  const consumerStackHome = path.join(owned.rootPath, 'consumer-stack');
  const trial = await resolveRemoteTrialStack({
    client: anon,
    ref: '@alice/frontend',
  });
  await preserveRemoteTrialStack({
    stackHome: consumerStackHome,
    trial,
    gitExecutor: fakeGit,
    client: anon,
  });
  assert(
    (await verifyStoredSkill({ stackHome: consumerStackHome, contentHash }))
      .state === 'available',
    'Trial reacquired the exact referenced Skill into the Store.',
  );
  assert(
    await missing(path.join(consumerStackHome, 'environments', 'main')),
    'Trial did not create main.',
  );
  assert(
    await missing(path.join(consumerStackHome, 'state', 'machines')).catch(
      () => true,
    ),
    'Trial created no binding registry.',
  );

  // --- Consumer: use into main --------------------------------------------
  await initializeMainEnvironment({
    stackHome: consumerStackHome,
    scanResult: emptyScan(),
  });
  const source = await resolvePublicStackSource({
    client: anon,
    ref: '@alice/frontend',
  });
  const proposal = await prepareRemoteStackUse({
    stackHome: consumerStackHome,
    source,
  });
  await applyRemoteStackUse(proposal, { gitExecutor: fakeGit, client: anon });
  const state = await loadMainEnvironment({ stackHome: consumerStackHome });
  assert(
    state.manifest.stacks[0]?.source?.kind === 'public',
    'Imported layer records its public source.',
  );
  assert(
    Object.values(state.lock.skills)[0]?.origins?.some(
      (o) => o.type === 'stack',
    ),
    'Requirement origins retained.',
  );

  // Offline after import: remove resolves with no cloud client.
  const removal = await prepareStackRemove({
    stackHome: consumerStackHome,
    identifier: 'frontend',
  });
  assert(removal.layer.name === 'frontend', 'Offline stack remove resolves.');

  // --- Security boundary: public access never grants private access --------
  const tokenB = await mintToken(USER_B, 'bob');
  let anonBlocked = false;
  try {
    await anon.getEnvironment('main');
  } catch {
    anonBlocked = true;
  }
  assert(anonBlocked, 'Private Environment API requires authentication.');
  let bBlocked = false;
  try {
    await clientFor(tokenB).downloadSnapshot(privHash);
  } catch {
    bBlocked = true;
  }
  assert(bBlocked, "User B cannot download the publisher's private snapshot.");

  console.log(
    'PASS: published a Git-backed public Stack with its portable snapshot; anonymous read + profile ' +
      'listing work; a consumer tried and used @alice/frontend with exact ' +
      'reacquisition; the imported layer works offline; and public access never ' +
      'exposed the publisher private Environment or snapshots.',
  );
} finally {
  await owned.cleanup();
  console.log('Owned temporary root cleaned.');
}

function emptyScan() {
  return {
    roots: [
      {
        path: '/tmp/none',
        rootKind: 'agents',
        scope: 'global',
        status: 'scanned',
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
  };
}
