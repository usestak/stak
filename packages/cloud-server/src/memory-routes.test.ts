import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryMemoryBackends,
  createInMemoryRepository,
  handleCloudRequest,
  type CloudRequest,
} from './index.js';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

const setup = (options: { withMemory?: boolean } = {}) => {
  const repository = createInMemoryRepository();
  const blobStore = createInMemoryBlobStore();
  const memory = createInMemoryMemoryBackends();
  let clock = new Date('2026-09-25T00:00:00.000Z');
  let counter = 0;
  const service = createCloudService({
    repository,
    blobStore,
    appUrl: 'http://localhost:3000',
    ticketSecret: 'test-ticket-secret',
    now: () => clock,
    randomId: () =>
      `00000000-0000-4000-8000-${(counter++).toString().padStart(12, '0')}`,
    randomSecret: () => `secret-${counter++}`,
    sessionTtlMs: 60_000,
    ...(options.withMemory === false
      ? {}
      : { memoryBackendFor: memory.memoryBackendFor }),
  });
  const call = (
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; jsonBody?: unknown }> => {
    const request: CloudRequest = {
      method,
      path: `/api/v1/${path}`,
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    };
    if (opts.body !== undefined) request.jsonBody = opts.body;
    return handleCloudRequest(service, request);
  };
  const signIn = async (userId: string): Promise<string> => {
    const start = await call('POST', 'cli/auth/start', { body: {} });
    const { userCode, deviceSecret } = start.jsonBody as {
      userCode: string;
      deviceSecret: string;
    };
    await service.approveCliAuth({
      userCode,
      profile: { userId, githubUsername: 'u' },
    });
    const token = await call('POST', 'cli/auth/token', {
      body: { deviceSecret },
    });
    return (token.jsonBody as { token: string }).token;
  };
  return {
    service,
    call,
    signIn,
    memory,
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
  };
};

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('remote Memory routes', () => {
  it('commits, lists, and reads back a Standard generation', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A);
    await call('POST', 'memory/profile-ensure', {
      token,
      body: { formatVersion: 'stack-mem-remote-v1' },
    });
    const created = await call('POST', 'memory/generations', {
      token,
      body: {
        backupId: 'b-0',
        expectedParent: null,
        privacyMode: 'standard',
        payloadB64: b64('hello-bundle'),
        bundleFormatVersion: 'stack-mem-bundle-v1',
      },
    });
    expect(created.status).toBe(200);
    expect(
      (created.jsonBody as { generation: { generation: number } }).generation
        .generation,
    ).toBe(0);

    const latest = await call('GET', 'memory/latest', { token });
    expect(
      (latest.jsonBody as { generation: { backupId: string } }).generation
        .backupId,
    ).toBe('b-0');

    const payload = await call('GET', 'memory/generations/b-0/payload', {
      token,
    });
    expect((payload.jsonBody as { payloadB64: string }).payloadB64).toBe(
      b64('hello-bundle'),
    );
  });

  it('commits a Protected generation carrying a wrapped DEK', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A);
    const created = await call('POST', 'memory/generations', {
      token,
      body: {
        backupId: 'p-0',
        expectedParent: null,
        privacyMode: 'protected',
        payloadB64: b64('ciphertext'),
        bundleFormatVersion: 'stack-mem-bundle-v1',
        cryptoVersion: 'stack-mem-cipher-v1',
        wrappedDek: { nonceB64: 'AA==', ciphertextB64: 'AA==', tagB64: 'AA==' },
      },
    });
    expect(created.status).toBe(200);
    const gen = (
      created.jsonBody as {
        generation: { privacyMode: string; wrappedDek?: unknown };
      }
    ).generation;
    expect(gen.privacyMode).toBe('protected');
    expect(gen.wrappedDek).toBeDefined();
  });

  it('rejects a stale-parent conflict', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A);
    await call('POST', 'memory/generations', {
      token,
      body: {
        backupId: 'b-0',
        expectedParent: null,
        privacyMode: 'standard',
        payloadB64: b64('a'),
        bundleFormatVersion: 'stack-mem-bundle-v1',
      },
    });
    const conflict = await call('POST', 'memory/generations', {
      token,
      body: {
        backupId: 'b-1',
        expectedParent: null,
        privacyMode: 'standard',
        payloadB64: b64('b'),
        bundleFormatVersion: 'stack-mem-bundle-v1',
      },
    });
    expect(conflict.status).toBe(409);
    expect((conflict.jsonBody as { error: { code: string } }).error.code).toBe(
      'memory-conflict',
    );
  });

  it('refuses an old-format (v1) generation once the account has pushed a v2 generation, with the @beta message', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A);
    const v2 = await call('POST', 'memory/generations', {
      token,
      body: {
        backupId: 'v2-0',
        expectedParent: null,
        privacyMode: 'standard',
        payloadB64: b64('v2-bundle'),
        bundleFormatVersion: 'stack-mem-bundle-v2',
      },
    });
    expect(v2.status).toBe(200);

    const rejected = await call('POST', 'memory/generations', {
      token,
      body: {
        backupId: 'v1-1',
        expectedParent: 0,
        privacyMode: 'standard',
        payloadB64: b64('v1-bundle'),
        bundleFormatVersion: 'stack-mem-bundle-v1',
      },
    });
    expect(rejected.status).toBe(409);
    expect(
      (rejected.jsonBody as { error: { code: string; message: string } }).error
        .code,
    ).toBe('memory-incompatible-format');
    // Task 13 fix round 2 (Minor): assert the FULL message, ASCII apostrophe,
    // matching the spec's exact wording (§9.3).
    expect(
      (rejected.jsonBody as { error: { code: string; message: string } }).error
        .message,
    ).toBe(
      "This account's Memory was upgraded by a newer STAK CLI. Update with `npm i -g @memstk/cli@beta`.",
    );

    // The rejection creates nothing — the account's latest is still the v2
    // generation, not a second (rejected) attempt.
    const latest = await call('GET', 'memory/latest', { token });
    expect(
      (latest.jsonBody as { generation: { backupId: string } }).generation
        .backupId,
    ).toBe('v2-0');

    // A v2 generation is still accepted after an account has v2 history.
    const v2Again = await call('POST', 'memory/generations', {
      token,
      body: {
        backupId: 'v2-1',
        expectedParent: 0,
        privacyMode: 'standard',
        payloadB64: b64('v2-bundle-2'),
        bundleFormatVersion: 'stack-mem-bundle-v2',
      },
    });
    expect(v2Again.status).toBe(200);
  });

  it('sticky gate + server-verified protect replicas over HTTP: a forged replicaOf is refused, an old-CLI v1 push is refused even when latest is a v1 replica (Task 13 fix round 3, A)', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A);
    const V1 = 'stack-mem-bundle-v1';
    // Real backups use UUID ids (the Supabase column is uuid) — and the DTO now
    // requires `replicaOf` to be one (Task 13 fix round 4).
    const ID = {
      v10: randomUUID(),
      v20: randomUUID(),
      v1r: randomUUID(),
      v2r: randomUUID(),
      old: randomUUID(),
      after: randomUUID(),
      missing: randomUUID(),
    };
    const V2 = 'stack-mem-bundle-v2';
    const protectedFields = {
      privacyMode: 'protected',
      cryptoVersion: 'stack-mem-cipher-v1',
      wrappedDek: { nonceB64: 'AA==', ciphertextB64: 'AA==', tagB64: 'AA==' },
    };
    const errorOf = (response: { jsonBody?: unknown }) =>
      (response.jsonBody as { error: { code: string; message: string } }).error;
    // Account history: v1 then v2, both Standard (original payloads 9 bytes each).
    await call('POST', 'memory/generations', {
      token,
      body: {
        backupId: ID.v10,
        expectedParent: null,
        privacyMode: 'standard',
        payloadB64: b64('v1-bundle'),
        bundleFormatVersion: V1,
      },
    });
    await call('POST', 'memory/generations', {
      token,
      body: {
        backupId: ID.v20,
        expectedParent: 0,
        privacyMode: 'standard',
        payloadB64: b64('v2-bundle'),
        bundleFormatVersion: V2,
      },
    });
    const replicaBody = (overrides: Record<string, unknown>) => ({
      backupId: randomUUID(),
      expectedParent: 1,
      ...protectedFields,
      payloadB64: b64('r'.repeat(9 + 28)),
      bundleFormatVersion: V1,
      replicaOf: ID.v10,
      ...overrides,
    });

    // No replicaOf at all: an ordinary v1 create after v2 -> the @beta gate.
    const unclaimed = await call('POST', 'memory/generations', {
      token,
      body: replicaBody({ replicaOf: undefined }),
    });
    expect(unclaimed.status).toBe(409);
    expect(errorOf(unclaimed).code).toBe('memory-incompatible-format');

    // Forged claims: unknown original, wrong format, wrong length, Standard replica.
    for (const overrides of [
      { replicaOf: ID.missing },
      { bundleFormatVersion: V2 },
      { payloadB64: b64('r'.repeat(9 + 27)) },
      { privacyMode: 'standard' },
    ]) {
      const forged = await call('POST', 'memory/generations', {
        token,
        body: replicaBody(overrides),
      });
      expect(forged.status).toBe(400);
      expect(errorOf(forged).code).toBe('memory-invalid-replica');
    }
    // A malformed replicaOf is a 400 refused replica, never a 500 from a uuid cast.
    const malformed = await call('POST', 'memory/generations', {
      token,
      body: replicaBody({ replicaOf: 'not-a-uuid' }),
    });
    expect(malformed.status).toBe(400);
    expect(errorOf(malformed).code).toBe('memory-invalid-replica');

    // The genuine replica of v1-0 is accepted and carries `replicaOf`.
    const replica = await call('POST', 'memory/generations', {
      token,
      body: replicaBody({ backupId: ID.v1r }),
    });
    expect(replica.status).toBe(200);
    const latest = await call('GET', 'memory/latest', { token });
    expect(
      (
        latest.jsonBody as {
          generation: { backupId: string; replicaOf?: string };
        }
      ).generation,
    ).toMatchObject({
      backupId: ID.v1r,
      replicaOf: ID.v10,
    });

    // A second replica of the same original is refused.
    const second = await call('POST', 'memory/generations', {
      token,
      body: replicaBody({ expectedParent: 2 }),
    });
    expect(second.status).toBe(400);
    expect(errorOf(second).code).toBe('memory-invalid-replica');

    // Latest is now a v1-format replica, but an old CLI's v1 Standard push is
    // STILL refused: the gate is sticky (a v2 generation was ever committed).
    const oldCli = await call('POST', 'memory/generations', {
      token,
      body: {
        backupId: ID.old,
        expectedParent: 2,
        privacyMode: 'standard',
        payloadB64: b64('v1-bundle-2'),
        bundleFormatVersion: V1,
      },
    });
    expect(oldCli.status).toBe(409);
    expect(errorOf(oldCli).message).toBe(
      "This account's Memory was upgraded by a newer STAK CLI. Update with `npm i -g @memstk/cli@beta`.",
    );

    // Replicate v2-0 too, finalize, and no replica exemption exists any more.
    const v2Replica = await call('POST', 'memory/generations', {
      token,
      body: replicaBody({
        backupId: ID.v2r,
        expectedParent: 2,
        bundleFormatVersion: V2,
        replicaOf: ID.v20,
      }),
    });
    expect(v2Replica.status).toBe(200);
    await call('POST', 'memory/privacy', {
      token,
      body: { privacyMode: 'protected' },
    });
    const afterFinalized = await call('POST', 'memory/generations', {
      token,
      body: {
        backupId: ID.after,
        expectedParent: 3,
        ...protectedFields,
        payloadB64: b64('v1-bundle'),
        bundleFormatVersion: V1,
      },
    });
    expect(afterFinalized.status).toBe(409);
    expect(errorOf(afterFinalized).code).toBe('memory-incompatible-format');
  });

  it('final review I6: an old CLI (0.1.2) protect is refused at its FIRST create — a Protected copy with no replicaOf on a Standard account with Standard backups — so nothing is copied, retired or finalized', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A);
    const original = randomUUID();
    await call('POST', 'memory/generations', {
      token,
      body: {
        backupId: original,
        expectedParent: null,
        privacyMode: 'standard',
        payloadB64: b64('v1-bundle'),
        bundleFormatVersion: 'stack-mem-bundle-v1',
      },
    });
    // The old protect's copy: Protected, same format, no replicaOf.
    const oldCopy = await call('POST', 'memory/generations', {
      token,
      body: {
        backupId: randomUUID(),
        expectedParent: 0,
        privacyMode: 'protected',
        payloadB64: b64('r'.repeat(9 + 28)),
        bundleFormatVersion: 'stack-mem-bundle-v1',
        cryptoVersion: 'stack-mem-cipher-v1',
        wrappedDek: { nonceB64: 'AA==', ciphertextB64: 'AA==', tagB64: 'AA==' },
      },
    });
    expect(oldCopy.status).toBe(409);
    const error = (
      oldCopy.jsonBody as { error: { code: string; message: string } }
    ).error;
    expect(error.code).toBe('memory-incompatible-format');
    expect(error.message).toContain('@memstk/cli@beta');
    const list = await call('GET', 'memory/generations', { token });
    const generations = (
      list.jsonBody as {
        generations: { backupId: string; privacyMode: string; state: string }[];
      }
    ).generations;
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({
      backupId: original,
      privacyMode: 'standard',
      state: 'committed',
    });
  });

  it('retire over the HTTP route is GUARDED: a Standard original with no committed Protected copy is refused (Task 13 fix round 5)', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A);
    const id = randomUUID();
    await call('POST', 'memory/generations', {
      token,
      body: {
        backupId: id,
        expectedParent: null,
        privacyMode: 'standard',
        payloadB64: b64('only-copy'),
        bundleFormatVersion: 'stack-mem-bundle-v2',
      },
    });
    const refused = await call('POST', `memory/generations/${id}/retire`, {
      token,
    });
    expect(refused.status).toBe(409);
    expect((refused.jsonBody as { error: { code: string } }).error.code).toBe(
      'memory-conflict',
    );
    const latest = await call('GET', 'memory/latest', { token });
    expect(
      (latest.jsonBody as { generation: { backupId: string; state: string } })
        .generation,
    ).toMatchObject({
      backupId: id,
      state: 'committed',
    });
  });

  it('does not leak another user’s payload', async () => {
    const { call, signIn } = setup();
    const tokenA = await signIn(USER_A);
    const tokenB = await signIn(USER_B);
    await call('POST', 'memory/generations', {
      token: tokenA,
      body: {
        backupId: 'a-0',
        expectedParent: null,
        privacyMode: 'standard',
        payloadB64: b64('secret'),
        bundleFormatVersion: 'stack-mem-bundle-v1',
      },
    });
    const stolen = await call('GET', 'memory/generations/a-0/payload', {
      token: tokenB,
    });
    expect(stolen.status).toBe(404);
    const listB = await call('GET', 'memory/generations', { token: tokenB });
    expect(
      (listB.jsonBody as { generations: unknown[] }).generations,
    ).toHaveLength(0);
  });

  it('requires authentication', async () => {
    const { call } = setup();
    const anon = await call('GET', 'memory/profile');
    expect(anon.status).toBe(401);
  });

  it('returns 501 when Memory is not configured on the server', async () => {
    const { call, signIn } = setup({ withMemory: false });
    const token = await signIn(USER_A);
    const res = await call('GET', 'memory/profile', { token });
    expect(res.status).toBe(501);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe(
      'memory-not-configured',
    );
  });

  it('runs the one-time recovery-session relay', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A);
    await call('POST', 'memory/sessions', {
      token,
      body: {
        sessionId: 's-0',
        direction: 'recovery',
        session: { hello: 'public-session' },
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    });
    await call('POST', 'memory/sessions/s-0/envelope', {
      token,
      body: { envelope: { ct: 'opaque' } },
    });
    const consumed = await call('POST', 'memory/sessions/s-0/consume', {
      token,
    });
    expect(consumed.status).toBe(200);
    expect(
      (consumed.jsonBody as { envelope: { ct: string } }).envelope.ct,
    ).toBe('opaque');
    const again = await call('POST', 'memory/sessions/s-0/consume', { token });
    expect(again.status).toBe(409);
    expect((again.jsonBody as { error: { code: string } }).error.code).toBe(
      'memory-session-consumed',
    );
  });

  it('rejects consuming an expired recovery session', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A);
    await call('POST', 'memory/sessions', {
      token,
      body: {
        sessionId: 's-exp',
        direction: 'recovery',
        session: { hello: 'x' },
        expiresAt: '2000-01-01T00:00:00.000Z',
      },
    });
    await call('POST', 'memory/sessions/s-exp/envelope', {
      token,
      body: { envelope: { ct: 'x' } },
    });
    const res = await call('POST', 'memory/sessions/s-exp/consume', { token });
    expect(res.status).toBe(410);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe(
      'memory-session-expired',
    );
  });

  it('does not expose another user’s recovery session or accept their submit', async () => {
    const { call, signIn } = setup();
    const tokenA = await signIn(USER_A);
    const tokenB = await signIn(USER_B);
    await call('POST', 'memory/sessions', {
      token: tokenA,
      body: {
        sessionId: 's-a',
        direction: 'recovery',
        session: { hello: 'a' },
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    });
    const fetchedByB = await call('GET', 'memory/sessions/s-a', {
      token: tokenB,
    });
    expect((fetchedByB.jsonBody as { session: unknown }).session).toBeNull();
    const submitByB = await call('POST', 'memory/sessions/s-a/envelope', {
      token: tokenB,
      body: { envelope: { ct: 'x' } },
    });
    expect(submitByB.status).toBe(404);
  });

  it('stores and lists recovery-method envelopes opaquely', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A);
    const added = await call('POST', 'memory/recovery-methods', {
      token,
      body: {
        type: 'recovery-file',
        label: 'Recovery file',
        publicIdentifier: null,
        mmkWrapper: { opaque: 'wrapper' },
        cryptoVersion: 'stack-mem-cipher-v1',
      },
    });
    expect(added.status).toBe(200);
    const list = await call('GET', 'memory/recovery-methods', { token });
    expect((list.jsonBody as { methods: unknown[] }).methods).toHaveLength(1);
  });
});
