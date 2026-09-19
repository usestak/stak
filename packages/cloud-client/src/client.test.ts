import { describe, expect, it } from 'vitest';

import {
  CloudUnavailableError,
  NotAuthenticatedError,
  StackCloudError,
  createCloudClient,
  type FetchLike,
} from './index.js';

const jsonResponse = (status: number, body: unknown) => ({
  status,
  headers: {
    get: (name: string) =>
      name === 'content-type' ? 'application/json' : null,
  },
  text: async () => JSON.stringify(body),
  arrayBuffer: async () => new ArrayBuffer(0),
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
});
