import { describe, expect, it, vi } from 'vitest';

import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  type ProductEvent,
} from './index.js';

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
