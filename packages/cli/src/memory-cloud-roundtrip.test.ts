import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCloudClient } from '@stack/cloud-client';
import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryMemoryBackends,
  createInMemoryRepository,
  createInProcessFetch,
} from '@stack/cloud-server';
import {
  cloudRecover,
  generateMmk,
  hashBytes,
  memoryStorePaths,
  protectedCloudBackup,
  readMemoryObject,
  standardCloudBackup,
  writeMemoryManifest,
  writeMemoryObject,
  type ManifestItem,
  type MemoryManifest,
} from '@stack/memory';

import { stackCloudRemoteMemoryBackend } from './memory/cloud-backend.js';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

const roots: string[] = [];
const tempHome = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

const writeSyntheticStore = async (projects: number, filesPer: number) => {
  const stackHome = await tempHome('stack-cli-mem-');
  const items: ManifestItem[] = [];
  const hashes: string[] = [];
  for (let p = 0; p < projects; p += 1) {
    for (let f = 0; f < filesPer; f += 1) {
      const body = Buffer.from(
        `# proj${p} file ${f}\ncontent ${p}/${f}\n`,
        'utf8',
      );
      const contentHash = hashBytes(body);
      await writeMemoryObject({ stackHome, contentHash, bytes: body });
      hashes.push(contentHash);
      items.push({
        provider: 'claude',
        kind: 'auto-memory',
        scope: 'project',
        logicalId: `claude/auto-memory/github.com/example/proj${p}/f${f}.md`,
        project: {
          kind: 'git',
          canonical: `github.com/example/proj${p}`,
          host: 'github.com',
          owner: 'example',
          repo: `proj${p}`,
        },
        contentHash,
        restoreTarget: {
          base: 'claude-project-memory',
          relativePath: `f${f}.md`,
        },
        capturedAt: '2026-09-25T12:00:00.000Z',
        sensitivity: 'private',
      });
    }
  }
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-25T12:00:00.000Z',
    items,
  };
  await writeMemoryManifest({ stackHome, manifest });
  return { stackHome, hashes };
};

const makeCloud = () => {
  const memory = createInMemoryMemoryBackends();
  let counter = 0;
  const service = createCloudService({
    repository: createInMemoryRepository(),
    blobStore: createInMemoryBlobStore(),
    appUrl: 'http://localhost:3000',
    ticketSecret: 'test-secret',
    randomId: () =>
      `00000000-0000-4000-8000-${(counter++).toString().padStart(12, '0')}`,
    randomSecret: () => `secret-${counter++}`,
    memoryBackendFor: memory.memoryBackendFor,
  });
  const fetchImpl = createInProcessFetch(service);
  const anon = createCloudClient({
    baseUrl: 'http://localhost:3000',
    fetchImpl,
  });
  const signIn = async (userId: string): Promise<string> => {
    const start = await anon.authStart({});
    await service.approveCliAuth({
      userCode: start.userCode,
      profile: { userId, githubUsername: 'u' },
    });
    const token = await anon.authToken({ deviceSecret: start.deviceSecret });
    if (token.status !== 'approved') throw new Error('sign-in failed');
    return token.token;
  };
  const backendForToken = (token: string) =>
    stackCloudRemoteMemoryBackend(
      createCloudClient({ baseUrl: 'http://localhost:3000', token, fetchImpl }),
    );
  return { signIn, backendForToken };
};

const assertByteExact = async (
  sourceHome: string,
  destHome: string,
  hashes: string[],
) => {
  const a = await readFile(memoryStorePaths(sourceHome).currentManifest);
  const b = await readFile(memoryStorePaths(destHome).currentManifest);
  expect(b.equals(a)).toBe(true);
  for (const contentHash of hashes) {
    const oa = await readMemoryObject({ stackHome: sourceHome, contentHash });
    const ob = await readMemoryObject({ stackHome: destHome, contentHash });
    expect(Buffer.from(ob).equals(Buffer.from(oa))).toBe(true);
  }
};

describe('CLI ↔ Cloud full-stack memory round-trip', () => {
  it('Standard: backup then recover byte-exactly across the real wire', async () => {
    const { signIn, backendForToken } = makeCloud();
    const backend = backendForToken(await signIn(USER_A));
    const source = await writeSyntheticStore(3, 2);
    const result = await standardCloudBackup({
      stackHome: source.stackHome,
      backend,
    });
    expect(result.privacyMode).toBe('standard');

    const dest = await tempHome('stack-cli-dst-');
    const recovered = await cloudRecover({ stackHome: dest, backend });
    expect(recovered.objects).toBe(source.hashes.length);
    await assertByteExact(source.stackHome, dest, source.hashes);
  });

  it('Protected: encrypt client-side, server stores ciphertext, recover with MMK', async () => {
    const { signIn, backendForToken } = makeCloud();
    const backend = backendForToken(await signIn(USER_A));
    const mmk = generateMmk();
    const source = await writeSyntheticStore(2, 2);
    const backup = await protectedCloudBackup({
      stackHome: source.stackHome,
      backend,
      mmk,
    });
    expect(backup.privacyMode).toBe('protected');

    // The server's stored payload is ciphertext (not the plaintext bundle).
    const payload = await backend.getPayload(backup.backupId);
    expect(Buffer.from(payload).toString('utf8')).not.toContain(
      'github.com/example',
    );

    const dest = await tempHome('stack-cli-dst-');
    const recovered = await cloudRecover({ stackHome: dest, backend, mmk });
    expect(recovered.privacyMode).toBe('protected');
    await assertByteExact(source.stackHome, dest, source.hashes);
  });

  it('Protected: a wrong MMK (account access alone) cannot decrypt', async () => {
    const { signIn, backendForToken } = makeCloud();
    const backend = backendForToken(await signIn(USER_A));
    const source = await writeSyntheticStore(1, 1);
    await protectedCloudBackup({
      stackHome: source.stackHome,
      backend,
      mmk: generateMmk(),
    });
    const dest = await tempHome('stack-cli-dst-');
    await expect(
      cloudRecover({ stackHome: dest, backend, mmk: generateMmk() }),
    ).rejects.toThrow();
  });

  it('another authenticated user cannot see or recover the first user’s memory', async () => {
    const cloud = makeCloud();
    const backendA = cloud.backendForToken(await cloud.signIn(USER_A));
    const backendB = cloud.backendForToken(await cloud.signIn(USER_B));
    const source = await writeSyntheticStore(1, 1);
    await standardCloudBackup({
      stackHome: source.stackHome,
      backend: backendA,
    });
    expect(await backendB.getLatest()).toBeNull();
    const dest = await tempHome('stack-cli-dst-');
    await expect(
      cloudRecover({ stackHome: dest, backend: backendB }),
    ).rejects.toThrow();
  });
});
