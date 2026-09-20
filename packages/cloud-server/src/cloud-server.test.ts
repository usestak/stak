import { describe, expect, it } from 'vitest';

import { sha256CanonicalJson } from '@stack/shared';
import type { CloudEnvironmentBundle, PublicStackBundle } from '@stack/spec';

import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  handleCloudRequest,
  type CloudRequest,
} from './index.js';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

const makeBundle = (digestHex: string): CloudEnvironmentBundle => ({
  schemaVersion: 1,
  environment: {
    schemaVersion: 1,
    name: 'main',
    skills: [],
    stacks: [],
    overrides: {},
  },
  resolved: { schemaVersion: 1, skills: {} },
  importedStackVersions: [],
  snapshotRequirements: [],
  digest: `sha256:${digestHex.padEnd(64, '0')}`,
});

const setup = () => {
  const repository = createInMemoryRepository();
  const blobStore = createInMemoryBlobStore();
  let clock = new Date('2026-09-19T00:00:00.000Z');
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
  });
  const call = (
    method: string,
    path: string,
    options: { token?: string; body?: unknown; bytes?: Uint8Array } = {},
  ) => {
    const request: CloudRequest = {
      method,
      path: `/api/v1/${path}`,
      headers: options.token
        ? { authorization: `Bearer ${options.token}` }
        : {},
    };
    if (options.bytes) request.binaryBody = options.bytes;
    else if (options.body !== undefined) request.jsonBody = options.body;
    return handleCloudRequest(service, request);
  };
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  const signIn = async (
    userId: string,
    githubUsername: string,
  ): Promise<string> => {
    const start = await call('POST', 'cli/auth/start', { body: {} });
    const userCode = (start.jsonBody as { userCode: string }).userCode;
    const deviceSecret = (start.jsonBody as { deviceSecret: string })
      .deviceSecret;
    await service.approveCliAuth({
      userCode,
      profile: { userId, githubUsername },
    });
    const token = await call('POST', 'cli/auth/token', {
      body: { deviceSecret },
    });
    return (token.jsonBody as { token: string }).token;
  };
  return { repository, blobStore, service, call, advance, signIn };
};

describe('cloud auth', () => {
  it('runs the device flow: start, approve, one-time token exchange', async () => {
    const { call, service, repository } = setup();
    const start = await call('POST', 'cli/auth/start', { body: {} });
    const body = start.jsonBody as {
      userCode: string;
      deviceSecret: string;
      verificationUri: string;
    };
    expect(body.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // A user code does not authorize the CLI by itself.
    const beforeApproval = await call('POST', 'cli/auth/token', {
      body: { deviceSecret: body.deviceSecret },
    });
    expect((beforeApproval.jsonBody as { status: string }).status).toBe(
      'pending',
    );

    await service.approveCliAuth({
      userCode: body.userCode,
      profile: { userId: USER_A, githubUsername: 'temi' },
    });
    const approved = await call('POST', 'cli/auth/token', {
      body: { deviceSecret: body.deviceSecret },
    });
    const token = approved.jsonBody as { status: string; token: string };
    expect(token.status).toBe('approved');
    expect(token.token).toMatch(/^stk_/);

    // No plaintext token or device secret is stored server-side.
    const stored = await repository.findTokenByHash(
      (await import('node:crypto'))
        .createHash('sha256')
        .update(token.token)
        .digest('hex'),
    );
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(token.token);

    // Consumed sessions cannot issue another token.
    const second = await call('POST', 'cli/auth/token', {
      body: { deviceSecret: body.deviceSecret },
    });
    expect((second.jsonBody as { status: string }).status).toBe('denied');
  });

  it('expires unapproved sessions', async () => {
    const { call, advance } = setup();
    const start = await call('POST', 'cli/auth/start', { body: {} });
    advance(120_000);
    const result = await call('POST', 'cli/auth/token', {
      body: {
        deviceSecret: (start.jsonBody as { deviceSecret: string }).deviceSecret,
      },
    });
    expect((result.jsonBody as { status: string }).status).toBe('expired');
  });

  it('rejects revoked tokens', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A, 'temi');
    expect((await call('GET', 'me', { token })).status).toBe(200);
    expect((await call('POST', 'cli/auth/revoke', { token })).status).toBe(200);
    const after = await call('GET', 'me', { token });
    expect(after.status).toBe(401);
  });

  it('requires authentication for protected routes', async () => {
    const { call } = setup();
    expect((await call('GET', 'me')).status).toBe(401);
    expect((await call('GET', 'environments/main')).status).toBe(401);
  });
});

describe('cloud environments', () => {
  it('creates the first version, then commits optimistically', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A, 'temi');
    expect((await call('GET', 'environments/main', { token })).status).toBe(
      404,
    );

    const first = await call('POST', 'environments/main/versions', {
      token,
      body: { bundle: makeBundle('a'), expectedLatestVersionId: null },
    });
    expect(first.status).toBe(200);
    const v1 = first.jsonBody as {
      version: { versionId: string; versionNumber: number };
      createdNew: boolean;
    };
    expect(v1.version.versionNumber).toBe(1);
    expect(v1.createdNew).toBe(true);

    const second = await call('POST', 'environments/main/versions', {
      token,
      body: {
        bundle: makeBundle('b'),
        expectedLatestVersionId: v1.version.versionId,
      },
    });
    expect(
      (second.jsonBody as { version: { versionNumber: number } }).version
        .versionNumber,
    ).toBe(2);

    // Stale base -> conflict, no overwrite.
    const stale = await call('POST', 'environments/main/versions', {
      token,
      body: {
        bundle: makeBundle('c'),
        expectedLatestVersionId: v1.version.versionId,
      },
    });
    expect(stale.status).toBe(409);
  });

  it('treats an existing remote as a conflict when the client expects none', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A, 'temi');
    await call('POST', 'environments/main/versions', {
      token,
      body: { bundle: makeBundle('a'), expectedLatestVersionId: null },
    });
    const conflict = await call('POST', 'environments/main/versions', {
      token,
      body: { bundle: makeBundle('b'), expectedLatestVersionId: null },
    });
    expect(conflict.status).toBe(409);
  });

  it('is idempotent for retried commits with the same key', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A, 'temi');
    const key = '00000000-0000-4000-8000-0000000000ff';
    const first = await call('POST', 'environments/main/versions', {
      token,
      body: {
        bundle: makeBundle('a'),
        expectedLatestVersionId: null,
        idempotencyKey: key,
      },
    });
    const retry = await call('POST', 'environments/main/versions', {
      token,
      body: {
        bundle: makeBundle('a'),
        expectedLatestVersionId: null,
        idempotencyKey: key,
      },
    });
    const a = first.jsonBody as { version: { versionId: string } };
    const b = retry.jsonBody as {
      version: { versionId: string };
      createdNew: boolean;
    };
    expect(b.version.versionId).toBe(a.version.versionId);
    expect(b.createdNew).toBe(false);
  });

  it('never exposes another user private Environment', async () => {
    const { call, signIn } = setup();
    const tokenA = await signIn(USER_A, 'alice');
    const tokenB = await signIn(USER_B, 'bob');
    await call('POST', 'environments/main/versions', {
      token: tokenA,
      body: { bundle: makeBundle('a'), expectedLatestVersionId: null },
    });
    // User B has no main even though A does.
    expect(
      (await call('GET', 'environments/main', { token: tokenB })).status,
    ).toBe(404);
    // User B creating main gets a fresh independent environment.
    const bCommit = await call('POST', 'environments/main/versions', {
      token: tokenB,
      body: { bundle: makeBundle('b'), expectedLatestVersionId: null },
    });
    expect(bCommit.status).toBe(200);
  });
});

describe('cloud snapshots', () => {
  const archive = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  it('uploads, deduplicates, downloads, and isolates by user', async () => {
    const crypto = await import('node:crypto');
    const hash = `sha256:${crypto.createHash('sha256').update(archive).digest('hex')}`;
    const contentHash = `sha256:${'a'.repeat(64)}`;
    const { call, signIn } = setup();
    const tokenA = await signIn(USER_A, 'alice');
    const tokenB = await signIn(USER_B, 'bob');

    const prepared = await call('POST', 'snapshots/prepare', {
      token: tokenA,
      body: { contentHash, archiveHash: hash, byteSize: archive.length },
    });
    const upload = prepared.jsonBody as {
      status: string;
      uploadTicket: string;
    };
    expect(upload.status).toBe('upload');
    const put = await call(
      'PUT',
      `snapshots/upload/${encodeURIComponent(upload.uploadTicket)}`,
      { token: tokenA, bytes: archive },
    );
    expect(put.status).toBe(204);
    const finalized = await call('POST', 'snapshots/finalize', {
      token: tokenA,
      body: {
        contentHash,
        archiveHash: hash,
        byteSize: archive.length,
        uploadTicket: upload.uploadTicket,
      },
    });
    expect(finalized.status).toBe(200);

    // Dedup: a second prepare for the same content reports it already exists.
    const again = await call('POST', 'snapshots/prepare', {
      token: tokenA,
      body: { contentHash, archiveHash: hash, byteSize: archive.length },
    });
    expect((again.jsonBody as { status: string }).status).toBe('exists');

    // Download round-trips the bytes for the owner.
    const download = await call(
      'GET',
      `snapshots/${encodeURIComponent(contentHash)}/download`,
      { token: tokenA },
    );
    const meta = download.jsonBody as {
      downloadTicket: string;
      byteSize: number;
    };
    const blob = await call(
      'GET',
      `snapshots/blob/${encodeURIComponent(meta.downloadTicket)}`,
      { token: tokenA },
    );
    expect(blob.status).toBe(200);
    expect([...(blob.binaryBody ?? [])]).toEqual([...archive]);

    // Cross-user: B cannot download A's snapshot even knowing the hash.
    const forbidden = await call(
      'GET',
      `snapshots/${encodeURIComponent(contentHash)}/download`,
      { token: tokenB },
    );
    expect(forbidden.status).toBe(404);
  });

  it('rejects an upload archive whose checksum does not match', async () => {
    const contentHash = `sha256:${'b'.repeat(64)}`;
    const { call, signIn } = setup();
    const token = await signIn(USER_A, 'alice');
    const wrongHash = `sha256:${'0'.repeat(64)}`;
    const prepared = await call('POST', 'snapshots/prepare', {
      token,
      body: { contentHash, archiveHash: wrongHash, byteSize: archive.length },
    });
    const ticket = (prepared.jsonBody as { uploadTicket: string }).uploadTicket;
    await call('PUT', `snapshots/upload/${encodeURIComponent(ticket)}`, {
      token,
      bytes: archive,
    });
    const finalized = await call('POST', 'snapshots/finalize', {
      token,
      body: {
        contentHash,
        archiveHash: wrongHash,
        byteSize: archive.length,
        uploadTicket: ticket,
      },
    });
    expect(finalized.status).toBe(400);
  });
});

const makePublicBundle = (options: {
  versionHash: string;
  remote?: string;
  snapshot?: boolean;
}): PublicStackBundle => {
  const contentHash = `sha256:${'a'.repeat(64)}`;
  const remote = options.remote ?? 'https://github.com/example/design.git';
  const requirement = {
    id: 'req_aaaaaaaa',
    name: 'design',
    requirement: 'required' as const,
    contentHash,
    metadata: { name: 'design', description: 'Design engineering' },
    restoration: options.snapshot
      ? ({
          strategy: 'snapshot',
          snapshotId: 'snap_aaaaaaaa',
          reason: 'local',
        } as never)
      : {
          strategy: 'reference' as const,
          reference: {
            remote,
            revision: 'a'.repeat(40),
            path: 'skills/design',
            expectedContentHash: contentHash,
          },
        },
    observedSources: [
      {
        type: 'git' as const,
        remote,
        revision: 'a'.repeat(40),
        path: 'skills/design',
        clean: true,
      },
    ],
    originStackName: 'frontend',
  };
  const stack = {
    name: 'frontend',
    description: 'Frontend Stack',
    versionHash: options.versionHash,
  };
  const inheritedStackMetadata: { name: string; versionHash: string }[] = [];
  return {
    schemaVersion: 1,
    stack,
    requirements: [requirement],
    inheritedStackMetadata,
    digest: sha256CanonicalJson({
      stack,
      requirements: [requirement],
      inheritedStackMetadata,
    }),
  };
};

describe('public stacks', () => {
  it('publishes, reads anonymously, and lists on the profile', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A, 'alice');
    const publish = await call('POST', 'stacks/frontend/versions', {
      token,
      body: {
        slug: 'frontend',
        bundle: makePublicBundle({ versionHash: `sha256:${'1'.repeat(64)}` }),
        expectedLatestVersionId: null,
      },
    });
    expect(publish.status).toBe(200);
    const published = publish.jsonBody as {
      owner: string;
      version: { versionNumber: number; versionId: string };
      createdNew: boolean;
    };
    expect(published.owner).toBe('alice');
    expect(published.version.versionNumber).toBe(1);
    expect(published.createdNew).toBe(true);

    // Anonymous reads (no token).
    const read = await call('GET', 'stacks/alice/frontend');
    expect(read.status).toBe(200);
    expect((read.jsonBody as { latest: unknown }).latest).not.toBeNull();
    const profile = await call('GET', 'profiles/alice');
    expect(
      (profile.jsonBody as { stacks: { slug: string }[] }).stacks.map(
        (s) => s.slug,
      ),
    ).toEqual(['frontend']);
    const unknown = await call('GET', 'stacks/alice/nope');
    expect(unknown.status).toBe(404);
  });

  it('no-ops, versions, conflicts, and is idempotent', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A, 'alice');
    const v1hash = `sha256:${'1'.repeat(64)}`;
    const first = await call('POST', 'stacks/frontend/versions', {
      token,
      body: {
        slug: 'frontend',
        bundle: makePublicBundle({ versionHash: v1hash }),
        expectedLatestVersionId: null,
      },
    });
    const v1 = (first.jsonBody as { version: { versionId: string } }).version;

    // No-op: same version hash + expected latest.
    const noop = await call('POST', 'stacks/frontend/versions', {
      token,
      body: {
        slug: 'frontend',
        bundle: makePublicBundle({ versionHash: v1hash }),
        expectedLatestVersionId: v1.versionId,
      },
    });
    expect((noop.jsonBody as { createdNew: boolean }).createdNew).toBe(false);

    // New version.
    const second = await call('POST', 'stacks/frontend/versions', {
      token,
      body: {
        slug: 'frontend',
        bundle: makePublicBundle({ versionHash: `sha256:${'2'.repeat(64)}` }),
        expectedLatestVersionId: v1.versionId,
      },
    });
    expect(
      (second.jsonBody as { version: { versionNumber: number } }).version
        .versionNumber,
    ).toBe(2);

    // Stale base -> conflict.
    const stale = await call('POST', 'stacks/frontend/versions', {
      token,
      body: {
        slug: 'frontend',
        bundle: makePublicBundle({ versionHash: `sha256:${'3'.repeat(64)}` }),
        expectedLatestVersionId: v1.versionId,
      },
    });
    expect(stale.status).toBe(409);

    // Idempotent retry.
    const key = '00000000-0000-4000-8000-0000000000ee';
    const a = await call('POST', 'stacks/other/versions', {
      token,
      body: {
        slug: 'other',
        bundle: makePublicBundle({ versionHash: `sha256:${'4'.repeat(64)}` }),
        expectedLatestVersionId: null,
        idempotencyKey: key,
      },
    });
    const b = await call('POST', 'stacks/other/versions', {
      token,
      body: {
        slug: 'other',
        bundle: makePublicBundle({ versionHash: `sha256:${'4'.repeat(64)}` }),
        expectedLatestVersionId: null,
        idempotencyKey: key,
      },
    });
    expect(
      (b.jsonBody as { version: { versionId: string } }).version.versionId,
    ).toBe(
      (a.jsonBody as { version: { versionId: string } }).version.versionId,
    );
  });

  it('rejects snapshot-backed and credential-bearing bundles server-side', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A, 'alice');
    const snapshot = await call('POST', 'stacks/frontend/versions', {
      token,
      body: {
        slug: 'frontend',
        bundle: makePublicBundle({
          versionHash: `sha256:${'1'.repeat(64)}`,
          snapshot: true,
        }),
        expectedLatestVersionId: null,
      },
    });
    expect(snapshot.status).toBe(400); // schema rejects non-reference restoration
    const credential = await call('POST', 'stacks/frontend/versions', {
      token,
      body: {
        slug: 'frontend',
        bundle: makePublicBundle({
          versionHash: `sha256:${'1'.repeat(64)}`,
          remote: 'https://tok@github.com/example/design.git',
        }),
        expectedLatestVersionId: null,
      },
    });
    expect(credential.status).toBe(422);
  });

  it('derives the owner from the token and isolates users', async () => {
    const { call, signIn } = setup();
    const tokenA = await signIn(USER_A, 'alice');
    const tokenB = await signIn(USER_B, 'bob');
    await call('POST', 'stacks/frontend/versions', {
      token: tokenA,
      body: {
        slug: 'frontend',
        bundle: makePublicBundle({ versionHash: `sha256:${'1'.repeat(64)}` }),
        expectedLatestVersionId: null,
      },
    });
    // B publishes under its own handle; cannot expect A's version and cannot
    // touch A's stack.
    const bPublish = await call('POST', 'stacks/frontend/versions', {
      token: tokenB,
      body: {
        slug: 'frontend',
        bundle: makePublicBundle({ versionHash: `sha256:${'9'.repeat(64)}` }),
        expectedLatestVersionId: null,
      },
    });
    expect((bPublish.jsonBody as { owner: string }).owner).toBe('bob');
    // A's stack still at version 1.
    const aRead = await call('GET', 'stacks/alice/frontend');
    expect(
      (aRead.jsonBody as { latest: { version: { versionNumber: number } } })
        .latest.version.versionNumber,
    ).toBe(1);
  });

  it('public read never grants access to private snapshot downloads', async () => {
    const { call } = setup();
    const anon = await call(
      'GET',
      `snapshots/${encodeURIComponent(`sha256:${'a'.repeat(64)}`)}/download`,
    );
    expect(anon.status).toBe(401);
  });

  it('never exposes internal ids or emails in public responses', async () => {
    const { call, signIn } = setup();
    const token = await signIn(USER_A, 'alice');
    await call('POST', 'stacks/frontend/versions', {
      token,
      body: {
        slug: 'frontend',
        bundle: makePublicBundle({ versionHash: `sha256:${'1'.repeat(64)}` }),
        expectedLatestVersionId: null,
      },
    });
    const stackJson = JSON.stringify(
      (await call('GET', 'stacks/alice/frontend')).jsonBody,
    );
    const profileJson = JSON.stringify(
      (await call('GET', 'profiles/alice')).jsonBody,
    );
    for (const secret of [USER_A, 'email', 'ownerUserId', 'user_id']) {
      expect(stackJson).not.toContain(secret);
      expect(profileJson).not.toContain(secret);
    }
  });
});
