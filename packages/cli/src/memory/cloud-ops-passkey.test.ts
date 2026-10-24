import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  InMemoryRemoteMemoryStore,
  addPasskeyWrapper,
  bridgeFailure,
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
  type BridgeFailureReason,
  type ManifestItem,
  type MemoryManifest,
  type RecoverySession,
  type RemoteMemoryBackend,
} from '@stack/memory';

import { runPasskeyProtect, runPasskeyRecover } from './cloud-ops.js';

const USER = 'user-passkey';
const secureKeys = (dir: string) =>
  fileLocalMemoryKeyStore(dir, {
    harden: () => Promise.resolve(true),
    verify: () => Promise.resolve(true),
  });
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
    const deviceA = secureKeys(await temp('stack-pk-a-'));

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
    const deviceB = secureKeys(await temp('stack-pk-b-'));
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
      localKeyStore: secureKeys(await temp('stack-pk-k-')),
      webBaseUrl: 'http://localhost:3000',
      openBrowser: () => undefined,
    });
    expect(result.status).toBe('not-authenticated');
  });
});

/** A controllable clock whose `sleep` advances time, so polling loops are deterministic. */
const makeClock = () => {
  let ms = 0;
  let sleeps = 0;
  return {
    now: () => new Date(ms),
    sleep: (delta: number) => {
      sleeps += 1;
      ms += delta;
      return Promise.resolve();
    },
    get sleepCount() {
      return sleeps;
    },
  };
};

/** A browser that relays a terminal failure signal through the one-time envelope. */
const failingBrowser =
  (backend: RemoteMemoryBackend, reason: BridgeFailureReason) =>
  async (url: string) => {
    await backend.submitRecoveryEnvelope(
      sessionIdFrom(url),
      bridgeFailure(reason),
    );
  };

describe('passkey bridge failures are bounded (R6)', () => {
  const baseDeps = async () => {
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const device = secureKeys(await temp('stack-pk-fail-'));
    const stackHome = await temp('stack-pk-fh-');
    return { store, backend, device, stackHome };
  };

  it('#3/#8 recover: user cancellation ends promptly as passkey-failed (no long poll)', async () => {
    const { backend, device, stackHome } = await baseDeps();
    const src = await writeStore();
    await standardCloudBackup({ stackHome: src.stackHome, backend });
    const clock = makeClock();
    const result = await runPasskeyRecover({
      stackHome,
      backend,
      localKeyStore: device,
      webBaseUrl: 'http://localhost:3000',
      openBrowser: failingBrowser(backend, 'cancelled'),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ status: 'passkey-failed', reason: 'cancelled' });
    expect(clock.sleepCount).toBe(0); // terminated immediately, did not keep polling
    expect(await device.hasKey()).toBe(false); // #10 no MMK enrolled
  });

  it('#4 recover: provider error → passkey-failed(provider-error)', async () => {
    const { backend, device, stackHome } = await baseDeps();
    const src = await writeStore();
    await standardCloudBackup({ stackHome: src.stackHome, backend });
    const result = await runPasskeyRecover({
      stackHome,
      backend,
      localKeyStore: device,
      webBaseUrl: 'http://localhost:3000',
      openBrowser: failingBrowser(backend, 'provider-error'),
      sleep: immediateSleep,
    });
    expect(result).toEqual({
      status: 'passkey-failed',
      reason: 'provider-error',
    });
  });

  it('#5 recover: PRF unsupported → passkey-failed(unsupported)', async () => {
    const { backend, device, stackHome } = await baseDeps();
    const src = await writeStore();
    await standardCloudBackup({ stackHome: src.stackHome, backend });
    const result = await runPasskeyRecover({
      stackHome,
      backend,
      localKeyStore: device,
      webBaseUrl: 'http://localhost:3000',
      openBrowser: failingBrowser(backend, 'unsupported'),
      sleep: immediateSleep,
    });
    expect(result).toEqual({ status: 'passkey-failed', reason: 'unsupported' });
  });

  it('#6 recover: browser never responds → bounded timeout (does not hang)', async () => {
    const { backend, device, stackHome } = await baseDeps();
    const src = await writeStore();
    await standardCloudBackup({ stackHome: src.stackHome, backend });
    const clock = makeClock();
    const result = await runPasskeyRecover({
      stackHome,
      backend,
      localKeyStore: device,
      webBaseUrl: 'http://localhost:3000',
      openBrowser: () => undefined, // browser opens but never submits
      sleep: clock.sleep,
      now: clock.now,
      timeoutMs: 100,
      pollMs: 1500,
    });
    expect(result).toEqual({ status: 'passkey-failed', reason: 'timed-out' });
  });

  it('#7 recover: session expiry → passkey-failed(session-expired)', async () => {
    const { backend, device, stackHome } = await baseDeps();
    const src = await writeStore();
    await standardCloudBackup({ stackHome: src.stackHome, backend });
    const clock = makeClock();
    const result = await runPasskeyRecover({
      stackHome,
      backend,
      localKeyStore: device,
      webBaseUrl: 'http://localhost:3000',
      openBrowser: () => undefined,
      sleep: clock.sleep,
      now: clock.now,
      ttlMs: 50, // session lifetime shorter than the poll budget
      timeoutMs: 10 * 60_000,
      pollMs: 1500,
    });
    expect(result).toEqual({
      status: 'passkey-failed',
      reason: 'session-expired',
    });
  });

  it('#10/#11 recover failure never produces an MMK, success, or recovery-state', async () => {
    const { backend, device, stackHome } = await baseDeps();
    const src = await writeStore();
    await standardCloudBackup({ stackHome: src.stackHome, backend });
    const result = await runPasskeyRecover({
      stackHome,
      backend,
      localKeyStore: device,
      webBaseUrl: 'http://localhost:3000',
      openBrowser: failingBrowser(backend, 'provider-error'),
      sleep: immediateSleep,
    });
    expect(result.status).not.toBe('recovered');
    expect(await device.hasKey()).toBe(false);
    // No local store / recovery-state was written by a failed recovery.
    await expect(
      readFile(memoryStorePaths(stackHome).recoveryState),
    ).rejects.toBeTruthy();
  });

  it('#9/#15 protect failure creates no wrapper and never auto-selects Standard', async () => {
    const { backend, device, stackHome } = await baseDeps();
    const src = await writeStore();
    await standardCloudBackup({ stackHome: src.stackHome, backend });
    const before = (await backend.getProfile())?.privacyMode;
    const result = await runPasskeyProtect({
      stackHome: src.stackHome,
      backend,
      localKeyStore: device,
      webBaseUrl: 'http://localhost:3000',
      openBrowser: failingBrowser(backend, 'cancelled'),
      sleep: immediateSleep,
    });
    void stackHome;
    expect(result).toEqual({ status: 'passkey-failed', reason: 'cancelled' });
    expect(await backend.listRecoveryMethods()).toEqual([]); // no passkey wrapper
    expect(await device.hasKey()).toBe(false); // no device enrollment
    // Privacy mode is unchanged — failure never silently downgrades to Standard.
    expect((await backend.getProfile())?.privacyMode).toBe(
      before ?? 'standard',
    );
  });

  it('#14 a failure result carries no PRF/MMK/DEK/recovery-key material', async () => {
    const { backend, device, stackHome } = await baseDeps();
    const src = await writeStore();
    await standardCloudBackup({ stackHome: src.stackHome, backend });
    const result = await runPasskeyRecover({
      stackHome,
      backend,
      localKeyStore: device,
      webBaseUrl: 'http://localhost:3000',
      openBrowser: failingBrowser(backend, 'provider-error'),
      sleep: immediateSleep,
    });
    const serialized = JSON.stringify(result).toLowerCase();
    for (const secret of ['mmk', 'prf', 'dek', 'recovery-key', 'wrapper'])
      expect(serialized).not.toContain(secret);
  });
});

describe('C1: passkey protect refuses an already-Protected account', () => {
  it('opens no browser ceremony and keeps the device MMK', async () => {
    const source = await writeStore();
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, USER);
    const device = secureKeys(await temp('stack-pk-c1-'));
    await standardCloudBackup({ stackHome: source.stackHome, backend });
    const prf = randomBytes(32);
    const browser = async (url: string) => {
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
      await backend.submitRecoveryEnvelope(session.sessionId, await sealMmkForPeer({ session, mmk }));
    };
    const deps = {
      stackHome: source.stackHome,
      backend,
      localKeyStore: device,
      webBaseUrl: 'http://localhost:3000',
      openBrowser: browser,
      sleep: immediateSleep,
    };
    expect((await runPasskeyProtect(deps)).status).toBe('protected');
    const mmkBefore = await device.loadMmk();
    let opened = 0;
    await expect(
      runPasskeyProtect({
        ...deps,
        openBrowser: async (url) => {
          opened += 1;
          await browser(url);
        },
      }),
    ).rejects.toMatchObject({ code: 'already-protected' });
    expect(opened).toBe(0);
    expect((await device.loadMmk())?.equals(mmkBefore as Buffer)).toBe(true);
    expect(await backend.listRecoveryMethods()).toHaveLength(1);
  });
});
