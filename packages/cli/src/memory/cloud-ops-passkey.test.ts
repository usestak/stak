import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  InMemoryRemoteMemoryStore,
  addPasskeyWrapper,
  fileLocalMemoryKeyStore,
  generateMmk,
  hashBytes,
  inMemoryRemoteMemoryBackend,
  memoryStorePaths,
  newKeyring,
  readMemoryObject,
  sealMmkForPeer,
  standardCloudBackup,
  unwrapWithPasskey,
  writeMemoryManifest,
  writeMemoryObject,
  type ManifestItem,
  type MemoryManifest,
  type RecoverySession,
  type RemoteMemoryBackend,
} from '@stack/memory';

import { runPasskeyProtect, runPasskeyRecover } from './cloud-ops.js';

const USER = 'user-passkey';
const roots: string[] = [];
const temp = async (p: string) => {
  const r = await mkdtemp(path.join(tmpdir(), p));
  roots.push(r);
  return r;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

const writeStore = async () => {
  const stackHome = await temp('stack-pk-src-');
  const items: ManifestItem[] = [];
  const hashes: string[] = [];
  for (let f = 0; f < 2; f += 1) {
    const body = Buffer.from(`# file ${f}\ncontent ${f}\n`, 'utf8');
    const contentHash = hashBytes(body);
    await writeMemoryObject({ stackHome, contentHash, bytes: body });
    hashes.push(contentHash);
    items.push({
      provider: 'claude',
      kind: 'auto-memory',
      scope: 'project',
      logicalId: `claude/auto-memory/github.com/example/atlas/f${f}.md`,
      project: {
        kind: 'git',
        canonical: 'github.com/example/atlas',
        host: 'github.com',
        owner: 'example',
        repo: 'atlas',
      },
      contentHash,
      restoreTarget: {
        base: 'claude-project-memory',
        relativePath: `f${f}.md`,
      },
      capturedAt: '2026-09-26T12:00:00.000Z',
      sensitivity: 'private',
    });
  }
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-26T12:00:00.000Z',
    items,
  };
  await writeMemoryManifest({ stackHome, manifest });
  return { stackHome, hashes };
};

const sessionIdFrom = (url: string) =>
  new URL(url).searchParams.get('session') ?? '';
const immediateSleep = () => Promise.resolve();

describe('passkey bridge flows (CLI ↔ relay ↔ simulated browser)', () => {
  it('protect enrolls via passkey and recover on a fresh device unlocks byte-exactly', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const prf = randomBytes(32); // stands in for the passkey PRF output
    const deviceA = fileLocalMemoryKeyStore(await temp('stack-pk-a-'));

    // Seed a Standard backup so protect has something to migrate.
    await standardCloudBackup({ stackHome: source.stackHome, backend });

    // Simulated browser for PROTECT: generate MMK, store its passkey wrapper, seal to CLI.
    const protectBrowser = async (url: string) => {
      const record = await backend.getRecoverySession(sessionIdFrom(url));
      const session = record?.session as RecoverySession;
      const mmk = generateMmk();
      const keyring = newKeyring();
      const { wrapper } = addPasskeyWrapper({ keyring, mmk, prfOutput: prf });
      await backend.addRecoveryMethod({
        type: 'passkey',
        label: 'Passkey',
        publicIdentifier: 'cred-1',
        mmkWrapper: { mmkId: keyring.mmkId, wrapper },
        cryptoVersion: 'stack-mem-cipher-v1',
      });
      const envelope = await sealMmkForPeer({ session, mmk });
      await backend.submitRecoveryEnvelope(session.sessionId, envelope);
    };

    const protectResult = await runPasskeyProtect({
      stackHome: source.stackHome,
      backend,
      localKeyStore: deviceA,
      webBaseUrl: 'http://localhost:3000',
      openBrowser: protectBrowser,
      sleep: immediateSleep,
    });
    expect(protectResult.status).toBe('protected');
    if (protectResult.status === 'protected')
      expect(protectResult.migrated).toBe(1);
    expect((await backend.getProfile())?.privacyMode).toBe('protected');
    expect(await deviceA.hasKey()).toBe(true);

    // Simulated browser for RECOVER: unwrap MMK via the stored passkey wrapper, seal to CLI.
    const recoverBrowser = async (url: string) => {
      const record = await backend.getRecoverySession(sessionIdFrom(url));
      const session = record?.session as RecoverySession;
      const methods = await backend.listRecoveryMethods();
      const stored = methods[0]?.mmkWrapper as {
        mmkId: string;
        wrapper: Parameters<typeof unwrapWithPasskey>[0]['wrapper'];
      };
      const keyring = { mmkId: stored.mmkId, wrappers: [stored.wrapper] };
      const mmk = unwrapWithPasskey({
        keyring,
        wrapper: stored.wrapper,
        prfOutput: prf,
      });
      const envelope = await sealMmkForPeer({ session, mmk });
      await backend.submitRecoveryEnvelope(session.sessionId, envelope);
    };

    // Fresh device B: no local MMK.
    const deviceB = fileLocalMemoryKeyStore(await temp('stack-pk-b-'));
    const dest = await temp('stack-pk-dst-');
    const backendB: RemoteMemoryBackend = inMemoryRemoteMemoryBackend(
      store,
      USER,
    );
    const recovered = await runPasskeyRecover({
      stackHome: dest,
      backend: backendB,
      localKeyStore: deviceB,
      webBaseUrl: 'http://localhost:3000',
      openBrowser: recoverBrowser,
      sleep: immediateSleep,
    });
    expect(recovered.status).toBe('recovered');
    expect(await deviceB.hasKey()).toBe(true);

    // Byte-exact reconstruction.
    const a = await readFile(
      memoryStorePaths(source.stackHome).currentManifest,
    );
    const b = await readFile(memoryStorePaths(dest).currentManifest);
    expect(b.equals(a)).toBe(true);
    for (const h of source.hashes) {
      const oa = await readMemoryObject({
        stackHome: source.stackHome,
        contentHash: h,
      });
      const ob = await readMemoryObject({ stackHome: dest, contentHash: h });
      expect(Buffer.from(ob).equals(Buffer.from(oa))).toBe(true);
    }

    // The envelope the server relayed carried no MMK plaintext.
    const relayed = JSON.stringify(
      store.sessions ? [...store.sessions.values()] : [],
    );
    expect(relayed).not.toContain('"mmk"');
  });

  it('protect reports not-authenticated when signed out', async () => {
    const result = await runPasskeyProtect({
      stackHome: await temp('stack-pk-'),
      backend: null,
      localKeyStore: fileLocalMemoryKeyStore(await temp('stack-pk-k-')),
      webBaseUrl: 'http://localhost:3000',
      openBrowser: () => undefined,
    });
    expect(result.status).toBe('not-authenticated');
  });
});
