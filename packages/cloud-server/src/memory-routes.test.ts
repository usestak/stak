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
