import { describe, expect, it } from 'vitest';

import {
  CloudResponseInvalidError,
  CloudUnavailableError,
  NotAuthenticatedError,
  StackCloudError,
  createCloudClient,
  type FetchLike,
} from './index.js';

// Independent of the client's own base64 encoder: this decodes the wire bytes back out so the
// test verifies a real round-trip rather than re-deriving the same string the implementation did.
const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64Decode = (encoded: string): Uint8Array => {
  const clean = encoded.replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | BASE64_CHARS.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
};

const jsonResponse = (status: number, body: unknown) => ({
  status,
  headers: {
    get: (name: string) =>
      name === 'content-type' ? 'application/json' : null,
  },
  text: async () => JSON.stringify(body),
  arrayBuffer: async () => new ArrayBuffer(0),
});

const binaryResponse = (status: number, bytes: Uint8Array) => ({
  status,
  headers: {
    get: (name: string) =>
      name === 'content-type' ? 'application/octet-stream' : null,
  },
  text: async () => '',
  arrayBuffer: async (): Promise<ArrayBuffer> =>
    bytes.buffer.slice(0) as ArrayBuffer,
});

describe('cloud client', () => {
  it('requires HTTPS outside localhost', () => {
    expect(() =>
      createCloudClient({
        baseUrl: 'http://cloud.example.com',
        fetchImpl: (() => {
          throw new Error('unused');
        }) as unknown as FetchLike,
      }),
    ).toThrow(StackCloudError);
    expect(() =>
      createCloudClient({
        baseUrl: 'http://localhost:3000',
        fetchImpl: (() => {
          throw new Error('unused');
        }) as unknown as FetchLike,
      }),
    ).not.toThrow();
  });

  it('requires a token before authenticated calls', async () => {
    const client = createCloudClient({
      baseUrl: 'http://localhost:3000',
      fetchImpl: (async () => jsonResponse(200, {})) as unknown as FetchLike,
    });
    await expect(client.me()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it('maps server error codes to typed errors', async () => {
    const fetchImpl = (async () =>
      jsonResponse(401, {
        error: { code: 'not-authenticated', message: 'nope' },
      })) as unknown as FetchLike;
    const client = createCloudClient({
      baseUrl: 'http://localhost:3000',
      token: 'stk_test',
      fetchImpl,
    });
    await expect(client.me()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it('returns null when an Environment is not found', async () => {
    const fetchImpl = (async () =>
      jsonResponse(404, {
        error: { code: 'remote-environment-not-found', message: 'no main' },
      })) as unknown as FetchLike;
    const client = createCloudClient({
      baseUrl: 'http://localhost:3000',
      token: 'stk_test',
      fetchImpl,
    });
    expect(await client.getEnvironment('main')).toBeNull();
  });

  const resolvedSkills = {
    schemaVersion: 1,
    skills: {
      skill_aaaaaaaa: {
        name: 'alpha',
        description: 'alpha skill',
        contentHash: `sha256:${'a'.repeat(64)}`,
        observedSources: [],
        restoration: {
          strategy: 'snapshot',
          contentHash: `sha256:${'a'.repeat(64)}`,
          reason: 'local',
        },
      },
    },
  };
  const environmentManifest = {
    schemaVersion: 1,
    name: 'main',
    skills: [{ id: 'skill_aaaaaaaa', name: 'alpha', requirement: 'required' }],
    stacks: [],
    overrides: {},
  };
  const okEnvironmentResponse = (bundle: Record<string, unknown>) =>
    jsonResponse(200, {
      environmentId: '00000000-0000-4000-8000-000000000000',
      name: 'main',
      latest: {
        version: {
          versionId: '00000000-0000-4000-8000-000000000001',
          versionNumber: 1,
          digest: `sha256:${'b'.repeat(64)}`,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        bundle,
      },
    });

  it('reads a legacy Environment bundle (no contentUploadRequirements) without throwing', async () => {
    const fetchImpl = (async () =>
      okEnvironmentResponse({
        schemaVersion: 1,
        environment: environmentManifest,
        resolved: resolvedSkills,
        importedStackVersions: [],
        digest: `sha256:${'b'.repeat(64)}`,
        // No contentUploadRequirements at all — the pre-eec8c26 production shape.
      })) as unknown as FetchLike;
    const client = createCloudClient({
      baseUrl: 'http://localhost:3000',
      token: 'stk_test',
      fetchImpl,
    });
    const result = await client.getEnvironment('main');
    expect(result?.latest?.bundle.contentUploadRequirements).toEqual([
      { contentHash: `sha256:${'a'.repeat(64)}` },
    ]);
  });

  it('wraps a genuinely malformed Environment bundle in CloudResponseInvalidError, not a raw ZodError', async () => {
    const fetchImpl = (async () =>
      okEnvironmentResponse({
        schemaVersion: 1,
        environment: environmentManifest,
        // `resolved` is missing entirely — not recoverable by the legacy-compat
        // normalization, which only ever fills in `contentUploadRequirements`.
        importedStackVersions: [],
        digest: `sha256:${'b'.repeat(64)}`,
      })) as unknown as FetchLike;
    const client = createCloudClient({
      baseUrl: 'http://localhost:3000',
      token: 'stk_test',
      fetchImpl,
    });
    await expect(client.getEnvironment('main')).rejects.toBeInstanceOf(
      CloudResponseInvalidError,
    );
  });

  it('surfaces transport failures as CloudUnavailable', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as FetchLike;
    const client = createCloudClient({
      baseUrl: 'http://localhost:3000',
      token: 'stk_test',
      fetchImpl,
    });
    await expect(client.me()).rejects.toBeInstanceOf(CloudUnavailableError);
  });

  it('reports a no-artifact skill source-check result', async () => {
    let capturedUrl = '';
    let capturedInit:
      { method: string; body?: string | Uint8Array } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(200, { ok: true });
    };
    const client = createCloudClient({
      baseUrl: 'http://localhost:3000',
      token: 'stk_test',
      fetchImpl,
    });
    const result = await client.reportSkillSourceCheck('skill_abc12345', {
      approvedContentHash: 'sha256:aaaa',
      sourceCheckState: 'no-update',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result).toEqual({ ok: true });
    expect(capturedUrl).toBe(
      'http://localhost:3000/api/v1/skills/skill_abc12345/review-check',
    );
    expect(capturedInit?.method).toBe('POST');
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      approvedContentHash: 'sha256:aaaa',
      sourceCheckState: 'no-update',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('approves a skill version by review artifact id only', async () => {
    let capturedUrl = '';
    let capturedInit:
      { method: string; body?: string | Uint8Array } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(200, {
        skillId: 'skill_abc12345',
        approvedVersion: 'sha256:bbbb',
        createdNew: true,
        environmentVersionNumber: 7,
      });
    };
    const client = createCloudClient({
      baseUrl: 'http://localhost:3000',
      token: 'stk_test',
      fetchImpl,
    });
    const result = await client.approveSkillVersion('skill_abc12345', {
      reviewArtifactId: '11111111-1111-1111-1111-111111111111',
    });
    expect(result).toEqual({
      skillId: 'skill_abc12345',
      approvedVersion: 'sha256:bbbb',
      createdNew: true,
      environmentVersionNumber: 7,
    });
    expect(capturedUrl).toBe(
      'http://localhost:3000/api/v1/skills/skill_abc12345/approve',
    );
    expect(capturedInit?.method).toBe('POST');
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      reviewArtifactId: '11111111-1111-1111-1111-111111111111',
    });
  });

  it('uploads a review artifact, base64-encoding the payload bytes inside the client', async () => {
    let capturedUrl = '';
    let capturedInit:
      { method: string; body?: string | Uint8Array } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(200, { reviewArtifactId: 'rev_1' });
    };
    const client = createCloudClient({
      baseUrl: 'http://localhost:3000',
      token: 'stk_test',
      fetchImpl,
    });
    const payloadBytes = new TextEncoder().encode(
      JSON.stringify({
        files: [{ relativePath: 'SKILL.md', afterText: 'hi' }],
      }),
    );
    const result = await client.uploadSkillReviewArtifact(
      'skill_abc12345',
      {
        approvedContentHash: 'sha256:aaaa',
        candidateRevision: 'deadbeef',
        candidateContentHash: 'sha256:cccc',
        artifactPayloadHash: 'sha256:dddd',
        checkedAt: '2026-01-01T00:00:00.000Z',
        files: [
          {
            relativePath: 'SKILL.md',
            kind: 'added',
            binary: false,
            after: { byteSize: 2, hash: 'sha256:eeee' },
          },
        ],
      },
      payloadBytes,
    );
    expect(result).toEqual({ reviewArtifactId: 'rev_1' });
    expect(capturedUrl).toBe(
      'http://localhost:3000/api/v1/skills/skill_abc12345/review-artifact',
    );
    expect(capturedInit?.method).toBe('POST');
    const sentBody = JSON.parse(capturedInit?.body as string) as {
      payloadBase64: string;
      files: unknown;
    };
    expect(new TextDecoder().decode(base64Decode(sentBody.payloadBase64))).toBe(
      new TextDecoder().decode(payloadBytes),
    );
    expect(sentBody.files).toEqual([
      {
        relativePath: 'SKILL.md',
        kind: 'added',
        binary: false,
        after: { byteSize: 2, hash: 'sha256:eeee' },
      },
    ]);
  });

  it('fetches a public Skill snapshot anonymously (Hybrid Public Skill Portability)', async () => {
    let capturedUrl = '';
    let capturedInit:
      { method: string; headers: Record<string, string> } | undefined;
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl: FetchLike = async (url, init) => {
      capturedUrl = url;
      capturedInit = init as typeof capturedInit;
      return binaryResponse(200, bytes);
    };
    const client = createCloudClient({
      baseUrl: 'http://localhost:3000',
      fetchImpl,
    });
    const result = await client.getPublicSkillSnapshot(
      'alice',
      'notes',
      1,
      'sha256:aaaa',
    );
    expect(result).toEqual(bytes);
    expect(capturedUrl).toBe(
      'http://localhost:3000/api/v1/stacks/alice/notes/versions/1/snapshots/sha256%3Aaaaa',
    );
    expect(capturedInit?.headers.authorization).toBeUndefined();
  });
});
