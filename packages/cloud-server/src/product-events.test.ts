import { describe, expect, it, vi } from 'vitest';

import { computeEnvironmentBundleDigest } from '@stack/shared';
import type { CloudEnvironmentBundle } from '@stack/spec';

import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
} from './index.js';

function makeEnvironmentBundle(name: string): CloudEnvironmentBundle {
  const environment = {
    schemaVersion: 1 as const,
    name,
    skills: [],
    stacks: [],
    overrides: {},
  };
  const resolved = { schemaVersion: 1 as const, skills: {} };
  const digest = computeEnvironmentBundleDigest({
    environment,
    resolved,
    importedStackVersions: [],
  });
  return {
    schemaVersion: 1,
    environment,
    resolved,
    importedStackVersions: [],
    contentUploadRequirements: [],
    digest,
  };
}

describe('recordEvent config option', () => {
  it('createCloudService accepts an optional recordEvent callback without it being called for unrelated operations', async () => {
    const recordEvent = vi.fn();
    const service = createCloudService({
      repository: createInMemoryRepository(),
      blobStore: createInMemoryBlobStore(),
      appUrl: 'http://localhost:3000',
      ticketSecret: 'test-secret',
      recordEvent,
    });
    expect(service).toBeTruthy();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('createCloudService still works when recordEvent is omitted entirely', () => {
    expect(() =>
      createCloudService({
        repository: createInMemoryRepository(),
        blobStore: createInMemoryBlobStore(),
        appUrl: 'http://localhost:3000',
        ticketSecret: 'test-secret',
      }),
    ).not.toThrow();
  });
});

describe('push/pull event recording', () => {
  it('records cloud.push.succeeded on a successful commitEnvironmentVersion, and does not affect the response', async () => {
    const recordEvent = vi.fn();
    const service = createCloudService({
      repository: createInMemoryRepository(),
      blobStore: createInMemoryBlobStore(),
      appUrl: 'http://localhost:3000',
      ticketSecret: 'test-secret',
      recordEvent,
    });
    const user = { userId: 'user-1', tokenId: 'token-1' };
    const result = await service.commitEnvironmentVersion(user, 'main', {
      bundle: makeEnvironmentBundle('main'),
      expectedLatestVersionId: null,
    });
    expect(result.createdNew).toBe(true);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', eventName: 'cloud.push.succeeded', success: true }),
    );
  });

  it('commitEnvironmentVersion still succeeds even if recordEvent throws', async () => {
    const recordEvent = vi.fn().mockRejectedValue(new Error('analytics db down'));
    const service = createCloudService({
      repository: createInMemoryRepository(),
      blobStore: createInMemoryBlobStore(),
      appUrl: 'http://localhost:3000',
      ticketSecret: 'test-secret',
      recordEvent,
    });
    const user = { userId: 'user-1', tokenId: 'token-1' };
    const result = await service.commitEnvironmentVersion(user, 'main', {
      bundle: makeEnvironmentBundle('main'),
      expectedLatestVersionId: null,
    });
    expect(result.createdNew).toBe(true); // the push itself must not fail
  });

  it('records cloud.pull.succeeded on a successful getEnvironment', async () => {
    const recordEvent = vi.fn();
    const service = createCloudService({
      repository: createInMemoryRepository(),
      blobStore: createInMemoryBlobStore(),
      appUrl: 'http://localhost:3000',
      ticketSecret: 'test-secret',
      recordEvent,
    });
    const user = { userId: 'user-1', tokenId: 'token-1' };
    await service.commitEnvironmentVersion(user, 'main', {
      bundle: makeEnvironmentBundle('main'),
      expectedLatestVersionId: null,
    });
    recordEvent.mockClear();
    await service.getEnvironment(user, 'main');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', eventName: 'cloud.pull.succeeded', success: true }),
    );
  });

  it('records cloud.pull.failed when getEnvironment throws not-found, and still throws', async () => {
    const recordEvent = vi.fn();
    const service = createCloudService({
      repository: createInMemoryRepository(),
      blobStore: createInMemoryBlobStore(),
      appUrl: 'http://localhost:3000',
      ticketSecret: 'test-secret',
      recordEvent,
    });
    const user = { userId: 'user-1', tokenId: 'token-1' };
    await expect(service.getEnvironment(user, 'does-not-exist')).rejects.toThrow();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', eventName: 'cloud.pull.failed', success: false }),
    );
  });
});
