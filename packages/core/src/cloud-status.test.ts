import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanSkills } from '@stack/scanner';
import type { GetEnvironmentResponse, SkillRoot } from '@stack/spec';

import { checkEnvironmentCloudSync } from './cloud-status.js';
import { buildCloudEnvironmentBundle } from './cloud-bundle.js';
import { initializeMainEnvironment } from './initialize.js';
import { loadMainEnvironment } from './state.js';
import { writeEnvironmentSyncState } from './sync-metadata.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-cloud-status-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

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

const remoteWith = (
  digest: string,
  versionId = '00000000-0000-4000-8000-000000000001',
  versionNumber = 1,
): GetEnvironmentResponse => ({
  environmentId: '00000000-0000-4000-8000-000000000000',
  name: 'main',
  latest: {
    version: {
      versionId,
      versionNumber,
      digest,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    bundle: {} as never,
  },
});

describe('checkEnvironmentCloudSync', () => {
  it('reports no-remote when nothing has been pushed', async () => {
    const home = await temp();
    const stackHome = await temp();
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });
    const result = await checkEnvironmentCloudSync({
      stackHome,
      client: { getEnvironment: async () => null },
    });
    expect(result).toEqual({ status: 'no-remote' });
  });

  it('reports up-to-date when local and remote digests match the last sync', async () => {
    const home = await temp();
    const stackHome = await temp();
    await writeSkill(path.join(home, 'alpha'), 'alpha');
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });
    const state = await loadMainEnvironment({ stackHome });
    const bundle = await buildCloudEnvironmentBundle({ stackHome });
    await writeEnvironmentSyncState({
      stackHome,
      machineId: state.machine.machineId,
      environment: 'main',
      state: {
        remoteEnvironmentId: '00000000-0000-4000-8000-000000000000',
        lastSyncedVersionId: '00000000-0000-4000-8000-000000000001',
        lastSyncedDigest: bundle.digest,
        syncedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await checkEnvironmentCloudSync({
      stackHome,
      client: { getEnvironment: async () => remoteWith(bundle.digest, '00000000-0000-4000-8000-000000000001') },
    });
    expect(result).toEqual({ status: 'up-to-date' });
  });

  it('reports ahead when local changed since the last sync but remote has not', async () => {
    const home = await temp();
    const stackHome = await temp();
    await writeSkill(path.join(home, 'alpha'), 'alpha');
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });
    const state = await loadMainEnvironment({ stackHome });
    await writeEnvironmentSyncState({
      stackHome,
      machineId: state.machine.machineId,
      environment: 'main',
      state: {
        remoteEnvironmentId: '00000000-0000-4000-8000-000000000000',
        lastSyncedVersionId: '00000000-0000-4000-8000-000000000001',
        lastSyncedDigest: 'sha256:' + 'a'.repeat(64),
        syncedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await checkEnvironmentCloudSync({
      stackHome,
      client: {
        getEnvironment: async () =>
          remoteWith('sha256:' + 'a'.repeat(64), '00000000-0000-4000-8000-000000000001'),
      },
    });
    expect(result).toEqual({ status: 'ahead' });
  });

  it('reports behind when remote advanced but local has not changed', async () => {
    const home = await temp();
    const stackHome = await temp();
    await writeSkill(path.join(home, 'alpha'), 'alpha');
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });
    const state = await loadMainEnvironment({ stackHome });
    const bundle = await buildCloudEnvironmentBundle({ stackHome });
    await writeEnvironmentSyncState({
      stackHome,
      machineId: state.machine.machineId,
      environment: 'main',
      state: {
        remoteEnvironmentId: '00000000-0000-4000-8000-000000000000',
        lastSyncedVersionId: '00000000-0000-4000-8000-000000000001',
        lastSyncedDigest: bundle.digest,
        syncedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await checkEnvironmentCloudSync({
      stackHome,
      client: {
        getEnvironment: async () =>
          remoteWith('sha256:' + 'b'.repeat(64), '00000000-0000-4000-8000-000000000002', 2),
      },
    });
    expect(result).toEqual({ status: 'behind', remoteVersionNumber: 2 });
  });

  it('reports diverged when both local and remote changed since the last sync', async () => {
    const home = await temp();
    const stackHome = await temp();
    await writeSkill(path.join(home, 'alpha'), 'alpha');
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });
    const state = await loadMainEnvironment({ stackHome });
    await writeEnvironmentSyncState({
      stackHome,
      machineId: state.machine.machineId,
      environment: 'main',
      state: {
        remoteEnvironmentId: '00000000-0000-4000-8000-000000000000',
        lastSyncedVersionId: '00000000-0000-4000-8000-000000000001',
        lastSyncedDigest: 'sha256:' + 'a'.repeat(64),
        syncedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await checkEnvironmentCloudSync({
      stackHome,
      client: {
        getEnvironment: async () =>
          remoteWith('sha256:' + 'b'.repeat(64), '00000000-0000-4000-8000-000000000002', 2),
      },
    });
    expect(result).toEqual({ status: 'diverged' });
  });

  it('reports diverged when cloud exists but this machine has never synced', async () => {
    const home = await temp();
    const stackHome = await temp();
    await writeSkill(path.join(home, 'alpha'), 'alpha');
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });
    const result = await checkEnvironmentCloudSync({
      stackHome,
      client: {
        getEnvironment: async () =>
          remoteWith('sha256:' + 'c'.repeat(64), '00000000-0000-4000-8000-000000000009', 9),
      },
    });
    expect(result).toEqual({ status: 'diverged' });
  });

  it('propagates a Cloud read/compatibility error unchanged — never swallows it as a sync state', async () => {
    // The CLI layer (program.ts's `checkCloud`) distinguishes a data/compatibility
    // failure (CloudResponseInvalidError) from a genuine network failure and must never
    // see the data-error case collapsed into "offline" — that distinction only works if
    // this function propagates whatever `client.getEnvironment` throws, unchanged.
    const home = await temp();
    const stackHome = await temp();
    await initializeMainEnvironment({
      stackHome,
      scanResult: await scanSkills({ roots: [claudeRoot(home)] }),
    });
    class FakeCloudResponseInvalidError extends Error {}
    await expect(
      checkEnvironmentCloudSync({
        stackHome,
        client: {
          getEnvironment: async () => {
            throw new FakeCloudResponseInvalidError('could not read bundle');
          },
        },
      }),
    ).rejects.toBeInstanceOf(FakeCloudResponseInvalidError);
  });
});
