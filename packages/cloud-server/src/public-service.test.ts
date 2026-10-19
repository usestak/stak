import { describe, expect, it } from 'vitest';

import { createInMemoryBlobStore } from './index.js';
import { hasPublishableSnapshot } from './public-service.js';

describe('hasPublishableSnapshot', () => {
  it('returns false when neither the owner bucket nor the published namespace has the content', async () => {
    const blobStore = createInMemoryBlobStore();
    const result = await hasPublishableSnapshot(
      blobStore,
      'user_a',
      'hash_never_pushed',
    );
    expect(result).toBe(false);
  });

  it('returns true when the owner has pushed the content (owner-scoped bucket)', async () => {
    const blobStore = createInMemoryBlobStore();
    await blobStore.put('user_a', 'hash_pushed', new Uint8Array([1, 2, 3]));
    const result = await hasPublishableSnapshot(
      blobStore,
      'user_a',
      'hash_pushed',
    );
    expect(result).toBe(true);
  });

  it('returns true when the content is already in the published namespace (e.g. republished by someone else with identical bytes)', async () => {
    const blobStore = createInMemoryBlobStore();
    await blobStore.putPublished(
      'hash_already_public',
      new Uint8Array([9, 9, 9]),
    );
    const result = await hasPublishableSnapshot(
      blobStore,
      'user_a',
      'hash_already_public',
    );
    expect(result).toBe(true);
  });
});
