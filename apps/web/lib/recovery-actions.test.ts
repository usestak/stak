import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryMemoryBackends,
  createInMemoryRepository,
} from '@stack/cloud-server';
import { describe, expect, it } from 'vitest';

import {
  addPasskeyMethod,
  fetchRecoverySession,
  latestKeyCheck,
  listPasskeyWrappers,
  submitRecoveryEnvelope,
} from './recovery-actions';

const USER_A = { id: 'user-a' };
const USER_B = { id: 'user-b' };

const service = () =>
  createCloudService({
    repository: createInMemoryRepository(),
    blobStore: createInMemoryBlobStore(),
    appUrl: 'http://localhost:3000',
    ticketSecret: 'test',
    memoryBackendFor: createInMemoryMemoryBackends().memoryBackendFor,
  });

const seedSession = async (
  svc: ReturnType<typeof service>,
  user: { id: string },
  opts: { expiresAt?: string } = {},
) => {
  await svc.memoryCreateSession(
    { userId: user.id },
    {
      sessionId: 's-1',
      direction: 'recovery',
      session: { initiatorPublicKeyB64: 'AAAA', sessionId: 's-1' },
      expiresAt: opts.expiresAt ?? '2099-01-01T00:00:00.000Z',
    },
  );
};

describe('recovery ceremony server logic', () => {
  it('fetches the caller’s own session', async () => {
    const svc = service();
    await seedSession(svc, USER_A);
    const result = await fetchRecoverySession(svc, USER_A, 's-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.direction).toBe('recovery');
  });

  it('does not expose another user’s session', async () => {
    const svc = service();
    await seedSession(svc, USER_A);
    const result = await fetchRecoverySession(svc, USER_B, 's-1');
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });

  it('rejects an expired session', async () => {
    const svc = service();
    await seedSession(svc, USER_A, { expiresAt: '2000-01-01T00:00:00.000Z' });
    const result = await fetchRecoverySession(svc, USER_A, 's-1');
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects an unknown/malformed session id', async () => {
    const svc = service();
    const result = await fetchRecoverySession(svc, USER_A, 'nope');
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });

  it('relays an opaque envelope and refuses cross-user submission', async () => {
    const svc = service();
    await seedSession(svc, USER_A);
    const ok = await submitRecoveryEnvelope(svc, USER_A, 's-1', {
      ct: 'opaque',
    });
    expect(ok).toEqual({ ok: true });
    const wrong = await submitRecoveryEnvelope(svc, USER_B, 's-1', { ct: 'x' });
    expect(wrong.ok).toBe(false);
  });

  it('adds and lists passkey wrappers (opaque)', async () => {
    const svc = service();
    await addPasskeyMethod(svc, USER_A, {
      label: 'Passkey',
      publicIdentifier: 'cred-b64url',
      mmkWrapper: { mmkId: 'm', wrapper: { opaque: true } },
    });
    const wrappers = await listPasskeyWrappers(svc, USER_A);
    expect(wrappers).toHaveLength(1);
    expect(wrappers[0]?.publicIdentifier).toBe('cred-b64url');
    // Isolation: user B sees none.
    expect(await listPasskeyWrappers(svc, USER_B)).toHaveLength(0);
  });
});

describe('latestKeyCheck (final review I7)', () => {
  it("returns the latest Protected generation's backup id and wrapped DEK (no payload), null otherwise, and only the caller's", async () => {
    const svc = service();
    expect(await latestKeyCheck(svc, USER_A)).toBeNull();
    await svc.memoryCreateGeneration(
      { userId: USER_A.id },
      {
        backupId: 'p-0',
        expectedParent: null,
        privacyMode: 'protected',
        payloadB64: Buffer.from('ciphertext').toString('base64'),
        bundleFormatVersion: 'stack-mem-bundle-v2',
        cryptoVersion: 'stack-mem-cipher-v1',
        wrappedDek: { nonceB64: 'AA==', ciphertextB64: 'AQ==', tagB64: 'Ag==' },
      },
    );
    expect(await latestKeyCheck(svc, USER_A)).toEqual({
      backupId: 'p-0',
      wrappedDek: { nonceB64: 'AA==', ciphertextB64: 'AQ==', tagB64: 'Ag==' },
    });
    expect(await latestKeyCheck(svc, USER_B)).toBeNull();
  });
});
