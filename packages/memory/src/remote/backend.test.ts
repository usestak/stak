import { describe, expect, it } from 'vitest';

import { BUNDLE_FORMAT, BUNDLE_FORMAT_V2 } from './bundle-codec.js';
import {
  InMemoryRemoteMemoryStore,
  RemoteMemoryError,
  inMemoryRemoteMemoryBackend,
  type RemoteMemoryBackend,
} from './backend.js';

const makeBackend = (userId = 'u1'): RemoteMemoryBackend =>
  inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), userId);

describe('version gate', () => {
  it('rejects a v1 generation once the latest committed generation is v2', async () => {
    const backend = makeBackend();
    await backend.createGeneration({
      backupId: 'b1',
      expectedParent: null,
      privacyMode: 'standard',
      payload: Buffer.from('v2-payload'),
      bundleFormatVersion: BUNDLE_FORMAT_V2,
    });
    await expect(
      backend.createGeneration({
        backupId: 'b2',
        expectedParent: 0,
        privacyMode: 'standard',
        payload: Buffer.from('v1-payload'),
        bundleFormatVersion: BUNDLE_FORMAT,
      }),
    ).rejects.toMatchObject({ code: 'incompatible-format' });
  });

  it('still allows v1 after v1 (no account has upgraded yet)', async () => {
    const backend = makeBackend();
    await backend.createGeneration({
      backupId: 'b1',
      expectedParent: null,
      privacyMode: 'standard',
      payload: Buffer.from('v1-payload-1'),
      bundleFormatVersion: BUNDLE_FORMAT,
    });
    await expect(
      backend.createGeneration({
        backupId: 'b2',
        expectedParent: 0,
        privacyMode: 'standard',
        payload: Buffer.from('v1-payload-2'),
        bundleFormatVersion: BUNDLE_FORMAT,
      }),
    ).resolves.toBeDefined();
  });

  it('allows v2 after v2', async () => {
    const backend = makeBackend();
    await backend.createGeneration({
      backupId: 'b1',
      expectedParent: null,
      privacyMode: 'standard',
      payload: Buffer.from('v2-payload-1'),
      bundleFormatVersion: BUNDLE_FORMAT_V2,
    });
    await expect(
      backend.createGeneration({
        backupId: 'b2',
        expectedParent: 0,
        privacyMode: 'standard',
        payload: Buffer.from('v2-payload-2'),
        bundleFormatVersion: BUNDLE_FORMAT_V2,
      }),
    ).resolves.toBeDefined();
  });

  it('the thrown error is a RemoteMemoryError instance', async () => {
    const backend = makeBackend();
    await backend.createGeneration({
      backupId: 'b1',
      expectedParent: null,
      privacyMode: 'standard',
      payload: Buffer.from('v2-payload'),
      bundleFormatVersion: BUNDLE_FORMAT_V2,
    });
    await expect(
      backend.createGeneration({
        backupId: 'b2',
        expectedParent: 0,
        privacyMode: 'standard',
        payload: Buffer.from('v1-payload'),
        bundleFormatVersion: BUNDLE_FORMAT,
      }),
    ).rejects.toBeInstanceOf(RemoteMemoryError);
  });
});
