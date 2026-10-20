import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanSkills } from '@stack/scanner';
import type { SkillRoot } from '@stack/spec';
import {
  applyPush,
  applySkillAdd,
  buildCloudEnvironmentBundle,
  initializeMainEnvironment,
  loadMainEnvironment,
  preparePush,
  prepareSkillAdd,
  writeEnvironmentSyncState,
} from '@stack/core';
import { createCloudClient } from '@stack/cloud-client';
import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  createInProcessFetch,
} from '@stack/cloud-server';

/**
 * Regression coverage for a real production failure: commit eec8c26 renamed the
 * `CloudEnvironmentBundle` field `snapshotRequirements` ({contentHash, reason}) to
 * `contentUploadRequirements` ({contentHash}) with no compatibility handling, so any
 * environment version a pre-rename CLI had already pushed to STAK Cloud became
 * unreadable (`ZodError` on `getEnvironment`) by the current CLI. These tests exercise
 * the REAL `preparePush`/`applyPush`/`CloudClient` pipeline against an in-memory Cloud
 * service seeded with the EXACT historical bundle shape (not a mock) — proving the new
 * CLI can read an old row, push a change on top of it, and read the new row back.
 */

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-legacy-bundle-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const USER_ID = '00000000-0000-4000-8000-00000000aaaa';

const makeCloud = () => {
  const repository = createInMemoryRepository();
  const blobStore = createInMemoryBlobStore();
  const service = createCloudService({
    repository,
    blobStore,
    appUrl: 'http://localhost:3000',
    ticketSecret: 'legacy-bundle-secret',
  });
  const fetchImpl = createInProcessFetch(service);
  const client = createCloudClient({
    baseUrl: 'http://localhost:3000',
    fetchImpl,
  });
  return { repository, service, client };
};

const signIn = async (
  service: ReturnType<typeof makeCloud>['service'],
  client: ReturnType<typeof makeCloud>['client'],
) => {
  const start = await client.authStart({});
  await service.approveCliAuth({
    userCode: start.userCode,
    profile: { userId: USER_ID, githubUsername: 'temi' },
  });
  const token = await client.authToken({ deviceSecret: start.deviceSecret });
  if (token.status !== 'approved') throw new Error('login failed');
  return token.token;
};

const writeSkill = async (directory: string, name: string) => {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`,
  );
};
const claudeRoot = (directory: string): SkillRoot => ({
  path: directory,
  rootKind: 'claude',
  scope: 'global',
});

describe('legacy Cloud environment bundle compatibility (real push pipeline)', () => {
  it('reads an old pre-rename bundle, pushes a change on top of it, and reads the new version back', async () => {
    const home = await temp();
    const stackHome = await temp();
    await writeSkill(path.join(home, 'alpha'), 'alpha');
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });

    const { repository, service, client: anonClient } = makeCloud();
    const token = await signIn(service, anonClient);
    const client = createCloudClient({
      baseUrl: 'http://localhost:3000',
      token,
      fetchImpl: createInProcessFetch(service),
    });

    // Build the bundle a CURRENT local main would produce (realistic resolved content),
    // then store it under STAK Cloud with the EXACT historical shape — derived from git
    // history (`git show eec8c26 -- packages/spec/src/cloud.ts`), not invented from
    // memory: field named `snapshotRequirements`, each entry `{contentHash, reason}`,
    // no `contentUploadRequirements` at all. This simulates a row an older CLI release
    // actually wrote before the rename.
    const currentBundle = await buildCloudEnvironmentBundle({ stackHome });
    const withoutCurrentField: Record<string, unknown> = { ...currentBundle };
    delete withoutCurrentField.contentUploadRequirements;
    const legacyBundle = {
      ...withoutCurrentField,
      snapshotRequirements: currentBundle.contentUploadRequirements.map(
        (requirement) => ({ ...requirement, reason: 'local' }),
      ),
    };
    const environmentId = randomUUID();
    const versionId = randomUUID();
    const now = '2026-01-01T00:00:00.000Z';
    await repository.commitEnvironmentVersion({
      userId: USER_ID,
      name: 'main',
      // Cast: this is deliberately NOT shaped like the current `CloudEnvironmentBundle`
      // type — it's the historical row the fix must still read.
      bundle: legacyBundle as unknown as Parameters<
        typeof repository.commitEnvironmentVersion
      >[0]['bundle'],
      digest: currentBundle.digest,
      expectedLatestVersionId: null,
      ids: { environmentId, versionId },
      now,
    });

    // This machine previously pushed/synced that exact legacy version with an older CLI.
    const main = await loadMainEnvironment({ stackHome });
    await writeEnvironmentSyncState({
      stackHome,
      machineId: main.machine.machineId,
      environment: 'main',
      state: {
        remoteEnvironmentId: environmentId,
        lastSyncedVersionId: versionId,
        lastSyncedDigest: currentBundle.digest,
        syncedAt: now,
      },
    });

    // 1/5: historical access — the real client reads the legacy row without a ZodError,
    // and its bundle's contentUploadRequirements is correctly derived (old `reason` tags
    // dropped, which is correct: current consumers don't need them).
    const remote = await client.getEnvironment('main');
    expect(remote?.latest?.bundle.contentUploadRequirements).toEqual(
      currentBundle.contentUploadRequirements,
    );

    // 2: preparePush against the old remote succeeds — nothing changed locally yet, so
    // this is a clean noop, not a crash.
    const noopPlan = await preparePush({ stackHome, client });
    expect(noopPlan.conflict).toBeNull();
    expect(noopPlan.noop).toBe(true);

    // Now make a real local change via `stak add .`.
    await writeSkill(path.join(home, 'beta'), 'beta');
    const addProposal = await prepareSkillAdd({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
      selectors: '.',
    });
    await applySkillAdd(addProposal);

    // 3/4: preparePush against the (still legacy-stored) remote now detects the local
    // change cleanly and applyPush creates a NEW, current-format version on top of it.
    const plan = await preparePush({ stackHome, client });
    expect(plan.conflict).toBeNull();
    expect(plan.noop).toBe(false);
    expect(plan.expectedLatestVersionId).toBe(versionId);
    const result = await applyPush({ stackHome, plan, client });
    expect(result.versionNumber).toBe(2);

    // 5: the current CLI reads the newly-pushed CURRENT version successfully, with a
    // real (non-derived-from-legacy) contentUploadRequirements.
    const updated = await client.getEnvironment('main');
    expect(updated?.latest?.version.versionNumber).toBe(2);
    expect(updated?.latest?.bundle.contentUploadRequirements.length).toBe(2);
  });
});
