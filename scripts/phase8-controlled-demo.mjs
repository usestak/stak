// Phase 8 controlled two-Machine cloud demonstration.
//
// Runs ENTIRELY inside a Phase 6.1 fenced, owned temporary root. Machine A and
// Machine B each get their own temporary HOME and STACK_HOME under that root.
// A fake in-process Stack Cloud API (the real cloud-server + cloud-client over
// an in-process transport) carries a push from Machine A to a pull on Machine B.
// It never writes to the real user HOME.

import { access, stat } from 'node:fs/promises';
import path from 'node:path';

import { CodexAdapter } from '../packages/adapters/dist/index.js';
import { createCloudClient } from '../packages/cloud-client/dist/index.js';
import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  createInProcessFetch,
} from '../packages/cloud-server/dist/index.js';
import {
  applyPull,
  applyPush,
  applyStackUse,
  buildCloudEnvironmentBundle,
  getOrCreateMachineIdentity,
  initializeMainEnvironment,
  loadMainEnvironment,
  preparePull,
  preparePush,
  prepareStackRemove,
  prepareStackUse,
} from '../packages/core/dist/index.js';
import {
  createOwnedTestRoot,
  hashSkillDirectory,
} from '../packages/shared/dist/index.js';
import { verifyStoredSkill } from '../packages/store/dist/index.js';

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

const owned = await createOwnedTestRoot('stack-phase8-demo-');
console.log(`Owned temporary root: ${owned.rootPath}`);

try {
  const USER = '00000000-0000-4000-8000-0000000000a1';

  // --- Fake in-process Stack Cloud -----------------------------------------
  const repository = createInMemoryRepository();
  const blobStore = createInMemoryBlobStore();
  const service = createCloudService({
    repository,
    blobStore,
    appUrl: 'http://localhost:3000',
    ticketSecret: 'phase8-demo-secret',
  });
  const fetchImpl = createInProcessFetch(service);
  const mintToken = async () => {
    const start = await service.startCliAuth({});
    await service.approveCliAuth({
      userCode: start.userCode,
      profile: { userId: USER, githubUsername: 'temi' },
    });
    const result = await service.pollCliToken(start.deviceSecret);
    if (result.status !== 'approved') throw new Error('login failed');
    return result.token;
  };
  const clientFor = (token) =>
    createCloudClient({ baseUrl: 'http://localhost', token, fetchImpl });

  const buildScanResult = (sourcesDir, seeded) => ({
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
      source: { type: 'local' },
      locations: [
        {
          path: item.dir,
          rootKind: 'agents',
          scope: 'global',
          rootPath: sourcesDir,
          isSymlink: false,
          realPath: item.dir,
          source: { type: 'local' },
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
  });

  // --- Machine A: local main + a Stack layer, then push --------------------
  const homeA = path.join(owned.rootPath, 'a-home');
  const stackHomeA = path.join(owned.rootPath, 'a-stack');
  const sourcesA = path.join(owned.rootPath, 'a-src');
  const seededA = [];
  for (const name of ['foo', 'bar']) {
    const dir = path.join(sourcesA, name);
    await owned.writeText(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} skill\n---\n${name} body\n`,
    );
    seededA.push({ name, dir, hash: (await hashSkillDirectory(dir)).hash });
  }
  await initializeMainEnvironment({
    stackHome: stackHomeA,
    scanResult: buildScanResult(sourcesA, seededA),
  });

  const stackDir = path.join(owned.rootPath, 'a-frontend');
  await owned.writeText(
    path.join(stackDir, 'stack.yaml'),
    'schemaVersion: 1\nname: frontend\ndescription: frontend stack\nskills:\n  - path: skills/design\n    requirement: required\n',
  );
  await owned.writeText(
    path.join(stackDir, 'skills', 'design', 'SKILL.md'),
    '---\nname: design\ndescription: design skill\n---\ndesign body\n',
  );
  await applyStackUse(
    await prepareStackUse({ stackHome: stackHomeA, input: stackDir }),
  );

  const tokenA = mintToken ? await mintToken() : '';
  const clientA = clientFor(tokenA);
  const pushPlan = await preparePush({ stackHome: stackHomeA, client: clientA });
  assert(!pushPlan.conflict, 'Machine A push should not conflict.');
  assert(!pushPlan.remoteExists, 'Cloud main should not exist before first push.');
  const pushResult = await applyPush({
    stackHome: stackHomeA,
    plan: pushPlan,
    client: clientA,
  });
  assert(pushResult.versionNumber === 1, 'First push should create version 1.');
  console.log(
    `Machine A pushed main v${pushResult.versionNumber} (${pushResult.uploaded} private snapshots).`,
  );

  const bundleA = await buildCloudEnvironmentBundle({ stackHome: stackHomeA });
  const stateA = await loadMainEnvironment({ stackHome: stackHomeA });

  // --- Machine B: fresh Machine pulls --------------------------------------
  const homeB = path.join(owned.rootPath, 'b-home');
  const stackHomeB = path.join(owned.rootPath, 'b-stack');
  assert(
    await missing(path.join(stackHomeB, 'environments', 'main')),
    'Machine B should start with no main.',
  );

  const tokenB = await mintToken();
  const clientB = clientFor(tokenB);
  const pullPlan = await preparePull({ stackHome: stackHomeB, client: clientB });
  assert(pullPlan.mode === 'create', 'Machine B should plan a fresh create.');
  const pullResult = await applyPull({
    stackHome: stackHomeB,
    plan: pullPlan,
    client: clientB,
  });
  assert(pullResult.status === 'restored', 'Machine B pull should restore main.');
  console.log(
    `Machine B pulled main: ${pullResult.desiredSkills} Skills, ${pullResult.importedStackVersions} Stack versions, ${pullResult.snapshotsDownloaded} snapshots downloaded.`,
  );

  const bundleB = await buildCloudEnvironmentBundle({ stackHome: stackHomeB });
  const stateB = await loadMainEnvironment({ stackHome: stackHomeB });

  // --- Verifications -------------------------------------------------------
  assert(bundleB.digest === bundleA.digest, 'Portable digests must match.');
  assert(
    JSON.stringify(stateB.manifest.skills) ===
      JSON.stringify(stateA.manifest.skills),
    'Portable Skill entry ids must match.',
  );
  assert(
    JSON.stringify(stateB.manifest.stacks) ===
      JSON.stringify(stateA.manifest.stacks),
    'Portable Stack layer ids must match.',
  );
  for (const [entryId, skill] of Object.entries(stateA.lock.skills)) {
    assert(
      stateB.lock.skills[entryId]?.contentHash === skill.contentHash,
      `Skill ${entryId} content hash must match.`,
    );
    const verification = await verifyStoredSkill({
      stackHome: stackHomeB,
      contentHash: skill.contentHash,
    });
    assert(
      verification.state === 'available',
      `Store object for ${entryId} must verify on Machine B.`,
    );
    if (skill.restoration.strategy === 'snapshot')
      assert(
        stateB.lock.skills[entryId]?.restoration.snapshotId !==
          skill.restoration.snapshotId,
        'Machine B must generate its own local snapshot ids.',
      );
  }
  assert(
    stateB.machine.machineId !== stateA.machine.machineId,
    'Machine B must have its own Machine id.',
  );
  for (const entry of Object.values(stateB.baseline.skills))
    assert(
      entry.locations.length === 0,
      'Machine B baseline placements must start empty.',
    );
  assert(
    await missing(
      path.join(
        stackHomeB,
        'state',
        'machines',
        stateB.machine.machineId,
        'bindings.json',
      ),
    ),
    'Machine A binding registry must not be imported.',
  );

  // Imported Stack layers survive on Machine B.
  const removal = await prepareStackRemove({
    stackHome: stackHomeB,
    identifier: 'frontend',
  });
  assert(removal.layer.name === 'frontend', 'Stack remove must resolve after pull.');

  // Project the restored Environment into Machine B's agent root.
  const codex = new CodexAdapter({ stackHome: stackHomeB, homeDir: homeB });
  const resolved = {
    name: stateB.manifest.name,
    machineId: stateB.machine.machineId,
    skills: Object.entries(stateB.lock.skills).map(([entryId, locked]) => ({
      entryId,
      name: locked.name,
      contentHash: locked.contentHash,
    })),
  };
  const bindingPlan = await codex.planBindings(resolved);
  await codex.applyBindings(bindingPlan, stateB.machine.machineId);
  for (const skill of Object.values(stateB.lock.skills))
    await access(path.join(homeB, '.agents', 'skills', skill.name));

  // Machine A private snapshot content is unreachable by a different user.
  const otherToken = await (async () => {
    const start = await service.startCliAuth({});
    await service.approveCliAuth({
      userCode: start.userCode,
      profile: { userId: '00000000-0000-4000-8000-0000000000b2', githubUsername: 'other' },
    });
    const result = await service.pollCliToken(start.deviceSecret);
    return result.status === 'approved' ? result.token : '';
  })();
  let isolated = false;
  try {
    await clientFor(otherToken).downloadSnapshot(seededA[0].hash);
  } catch {
    isolated = true;
  }
  assert(isolated, 'Another user must not download Machine A snapshots.');

  console.log(
    'PASS: Machine B reconstructed the same portable main (matching digest, ' +
      'logical ids, and Skill hashes), restored imported Stack layers, generated ' +
      'its own Machine id and local snapshot ids, did not import Machine A ' +
      'bindings, projected the Environment into its own agent root, and cross-user ' +
      'snapshot access was denied.',
  );
} finally {
  await owned.cleanup();
  console.log('Owned temporary root cleaned.');
}
