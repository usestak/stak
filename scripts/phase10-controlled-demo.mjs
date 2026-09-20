// Phase 10 comprehensive V0 demonstration.
//
// One fenced run covering the three V0 journeys: local, cross-machine recovery,
// and public sharing. Uses fake agents (no launch), an in-process Stack Cloud,
// and injected Git reacquisition. Everything is confined to an owned temporary
// root; a real-home canary is asserted untouched.

import { execFileSync } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  CodexAdapter,
  CursorAdapter,
  ClaudeAdapter,
} from '../packages/adapters/dist/index.js';
import { createCloudClient } from '../packages/cloud-client/dist/index.js';
import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  createInProcessFetch,
} from '../packages/cloud-server/dist/index.js';
import {
  applyPublish,
  applyPull,
  applyPush,
  applyRemoteStackUse,
  applyStackUse,
  initializeMainEnvironment,
  loadMainEnvironment,
  prepareRemoteStackUse,
  preparePublish,
  preparePull,
  preparePush,
  prepareStackRemove,
  prepareStackUse,
  resolvePublicStackSource,
} from '../packages/core/dist/index.js';
import {
  createOwnedTestRoot,
  hashSkillDirectory,
} from '../packages/shared/dist/index.js';
import { verifyStoredSkill } from '../packages/store/dist/index.js';

const assert = (c, m) => {
  if (!c) throw new Error(m);
};

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const REMOTE = 'https://example.com/example/design.git';
const DESIGN_BODY =
  '---\nname: design\ndescription: Design\n---\ndesign body\n';

const owned = await createOwnedTestRoot('stack-phase10-demo-');
console.log(`Owned temporary root: ${owned.rootPath}`);

try {
  // Real-home canary: must be byte-for-byte unchanged at the end.
  const canary = path.join(
    owned.rootPath,
    'REAL-HOME',
    '.agents',
    'skills',
    'canary',
    'SKILL.md',
  );
  await owned.writeText(canary, 'do-not-touch');
  const canaryBefore = await readFile(canary, 'utf8');

  const repository = createInMemoryRepository();
  const service = createCloudService({
    repository,
    blobStore: createInMemoryBlobStore(),
    appUrl: 'http://localhost:3000',
    ticketSecret: 'phase10-demo-secret',
  });
  const fetchImpl = createInProcessFetch(service);
  const clientFor = (token) =>
    createCloudClient({
      baseUrl: 'http://localhost',
      ...(token ? { token } : {}),
      fetchImpl,
    });
  const mint = async (userId, github) => {
    const s = await service.startCliAuth({});
    await service.approveCliAuth({
      userCode: s.userCode,
      profile: { userId, githubUsername: github },
    });
    const r = await service.pollCliToken(s.deviceSecret);
    return r.token;
  };
  const fakeGit = async (args, { cwd }) => {
    if (args[0] === 'checkout') {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const dest = path.join(cwd, 'skills', 'design');
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, 'SKILL.md'), DESIGN_BODY);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const localScan = (dir, hash, name) => ({
    roots: [
      {
        path: dir,
        rootKind: 'agents',
        scope: 'global',
        status: 'scanned',
        skillLocations: 1,
      },
    ],
    skills: [
      {
        contentHash: hash,
        metadata: { name, description: name },
        valid: true,
        source: { type: 'local' },
        locations: [
          {
            path: path.join(dir, name),
            rootKind: 'agents',
            scope: 'global',
            rootPath: dir,
            isSymlink: false,
            realPath: path.join(dir, name),
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
  });
  const resolvedFor = async (stackHome) => {
    const state = await loadMainEnvironment({ stackHome });
    return {
      machineId: state.machine.machineId,
      resolved: {
        name: state.manifest.name,
        machineId: state.machine.machineId,
        skills: Object.entries(state.lock.skills).map(([entryId, l]) => ({
          entryId,
          name: l.name,
          contentHash: l.contentHash,
        })),
      },
    };
  };
  const runAgent = async (Adapter, stackHome, homeDir) => {
    const { machineId, resolved } = await resolvedFor(stackHome);
    const adapter = new Adapter({ stackHome, homeDir });
    await adapter.applyBindings(
      await adapter.planBindings(resolved),
      machineId,
    );
  };

  // Build a git-reference authoring Stack 'frontend' (design).
  const authoring = path.join(owned.rootPath, 'authoring');
  await owned.writeText(
    path.join(authoring, 'stack.yaml'),
    'schemaVersion: 1\nname: frontend\ndescription: Frontend\nskills:\n  - path: skills/design\n    requirement: required\n',
  );
  await owned.writeText(
    path.join(authoring, 'skills', 'design', 'SKILL.md'),
    DESIGN_BODY,
  );
  const g = (args) =>
    execFileSync('git', args, { cwd: authoring, stdio: 'ignore' });
  g(['init', '-q']);
  g(['config', 'user.email', 'd@e.com']);
  g(['config', 'user.name', 'D']);
  g(['add', '.']);
  g(['commit', '-q', '-m', 'i']);
  g(['remote', 'add', 'origin', REMOTE]);
  const designHash = (
    await hashSkillDirectory(path.join(authoring, 'skills', 'design'))
  ).hash;

  // ---- Journey 1: Machine A local ----
  const homeA = path.join(owned.rootPath, 'a-home');
  const stackA = path.join(owned.rootPath, 'a-stack');
  const fooSrc = path.join(owned.rootPath, 'a-src', 'foo');
  await owned.writeText(
    path.join(fooSrc, 'SKILL.md'),
    '---\nname: foo\ndescription: foo\n---\nfoo\n',
  );
  const fooHash = (await hashSkillDirectory(fooSrc)).hash;
  await initializeMainEnvironment({
    stackHome: stackA,
    scanResult: localScan(path.join(owned.rootPath, 'a-src'), fooHash, 'foo'),
  });
  await applyStackUse(
    await prepareStackUse({ stackHome: stackA, input: authoring }),
  );
  await runAgent(CodexAdapter, stackA, homeA);
  await runAgent(CursorAdapter, stackA, homeA);
  await runAgent(ClaudeAdapter, stackA, homeA);
  await access(path.join(homeA, '.agents', 'skills', 'foo'));
  await access(path.join(homeA, '.agents', 'skills', 'design'));
  await access(path.join(homeA, '.claude', 'skills', 'design'));
  console.log(
    'Machine A: scanned, initialised, used a Stack, ran codex+cursor+claude.',
  );

  // ---- push + publish ----
  const tokenA = await mint(USER_A, 'alice');
  await applyPush({
    stackHome: stackA,
    plan: await preparePush({ stackHome: stackA, client: clientFor(tokenA) }),
    client: clientFor(tokenA),
  });
  const published = await applyPublish({
    plan: await preparePublish({
      stackHome: stackA,
      input: authoring,
      client: clientFor(tokenA),
    }),
    client: clientFor(tokenA),
  });
  assert(published.owner === 'alice', 'publish owner');
  console.log(
    `Machine A: pushed main; published @${published.owner}/${published.slug}.`,
  );

  // ---- Journey 2: Machine B recovery ----
  const stackB = path.join(owned.rootPath, 'b-stack');
  const homeB = path.join(owned.rootPath, 'b-home');
  const tokenB = await mint(USER_A, 'alice');
  const pullPlan = await preparePull({
    stackHome: stackB,
    client: clientFor(tokenB),
  });
  await applyPull({
    stackHome: stackB,
    plan: pullPlan,
    client: clientFor(tokenB),
    gitExecutor: fakeGit,
  });
  for (const h of [fooHash, designHash])
    assert(
      (await verifyStoredSkill({ stackHome: stackB, contentHash: h })).state ===
        'available',
      'store restored',
    );
  await runAgent(CodexAdapter, stackB, homeB);
  await access(path.join(homeB, '.agents', 'skills', 'foo'));
  const stateA = await loadMainEnvironment({ stackHome: stackA });
  const stateB = await loadMainEnvironment({ stackHome: stackB });
  assert(
    stateB.machine.machineId !== stateA.machine.machineId,
    'machine ids differ',
  );
  console.log('Machine B: logged in, pulled, ran codex; setup reconstructed.');

  // ---- Journey 3: User B public consumption ----
  const anon = clientFor(undefined);
  const pub = await anon.getPublicStack('alice', 'frontend');
  assert(pub?.latest, 'anonymous public read');
  const stackC = path.join(owned.rootPath, 'c-stack');
  const homeC = path.join(owned.rootPath, 'c-home');
  await initializeMainEnvironment({
    stackHome: stackC,
    scanResult: {
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
    },
  });
  const source = await resolvePublicStackSource({
    client: anon,
    ref: '@alice/frontend',
  });
  await applyRemoteStackUse(
    await prepareRemoteStackUse({ stackHome: stackC, source }),
    { gitExecutor: fakeGit },
  );
  await runAgent(CursorAdapter, stackC, homeC);
  await access(path.join(homeC, '.agents', 'skills', 'design'));
  // Cloud offline: local commands still work.
  const removal = await prepareStackRemove({
    stackHome: stackC,
    identifier: 'frontend',
  });
  assert(removal.layer.name === 'frontend', 'offline remove resolves');
  // Cross-user isolation: User B cannot download User A's private snapshot.
  let blocked = false;
  try {
    await clientFor(await mint(USER_B, 'bob')).downloadSnapshot(fooHash);
  } catch {
    blocked = true;
  }
  assert(blocked, 'private snapshot isolation');
  console.log(
    'User B: read + used the public Stack, ran cursor, offline remove works, private data isolated.',
  );

  // ---- Real-home canary ----
  assert(
    (await readFile(canary, 'utf8')) === canaryBefore,
    'real-home canary changed',
  );
  await stat(canary);

  console.log(
    'PASS: local, recovery, and public journeys all succeeded; the real-home canary is untouched.',
  );
} finally {
  await owned.cleanup();
  console.log('Owned temporary root cleaned.');
}
