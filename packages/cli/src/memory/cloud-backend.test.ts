import { describe, expect, it, vi } from 'vitest';

import { StackCloudError, type CloudMemoryClient } from '@stack/cloud-client';
import { RemoteMemoryError } from '@stack/memory';

import { stackCloudRemoteMemoryBackend } from './cloud-backend.js';

/**
 * Task 13 fix round 2, Important-2: over real HTTP, a conflicting
 * `createGeneration` surfaces as a `StackCloudError` with `code:
 * 'memory-conflict'` (the server's actual error code), never the domain's own
 * `RemoteMemoryError('conflict', …)` shape. `pushCanonicalMemory`'s retry loop
 * only recognizes the latter, so the retry never fired at all over real HTTP —
 * a 409 just propagated as an opaque failure. `stackCloudRemoteMemoryBackend`
 * must normalize this at the adapter boundary.
 */
describe('stackCloudRemoteMemoryBackend — HTTP conflict normalization (Task 13 fix round 2, Important-2)', () => {
  it('normalizes a StackCloudError(memory-conflict) from createGeneration into RemoteMemoryError(conflict)', async () => {
    const client = {
      memoryCreateGeneration: vi.fn(async () => {
        throw new StackCloudError('memory-conflict', 'Cloud latest generation is 2, not 1.');
      }),
    } as unknown as CloudMemoryClient;
    const backend = stackCloudRemoteMemoryBackend(client);

    await expect(
      backend.createGeneration({
        backupId: 'b-0',
        expectedParent: 1,
        privacyMode: 'standard',
        payload: new Uint8Array(),
        bundleFormatVersion: 'stack-mem-bundle-v2',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    try {
      await backend.createGeneration({
        backupId: 'b-1',
        expectedParent: 1,
        privacyMode: 'standard',
        payload: new Uint8Array(),
        bundleFormatVersion: 'stack-mem-bundle-v2',
      });
      throw new Error('expected createGeneration to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteMemoryError);
    }
  });

  it('leaves a non-conflict StackCloudError (e.g. too-large) untouched', async () => {
    const client = {
      memoryCreateGeneration: vi.fn(async () => {
        throw new StackCloudError('memory-too-large', 'Memory payload is too large.');
      }),
    } as unknown as CloudMemoryClient;
    const backend = stackCloudRemoteMemoryBackend(client);

    await expect(
      backend.createGeneration({
        backupId: 'b-0',
        expectedParent: null,
        privacyMode: 'standard',
        payload: new Uint8Array(),
        bundleFormatVersion: 'stack-mem-bundle-v2',
      }),
    ).rejects.toMatchObject({ code: 'memory-too-large' });
  });

  it('the retry loop actually fires through pushCanonicalMemory over this adapter', async () => {
    const { pushCanonicalMemory, CANONICAL_MAIN_SCHEMA_VERSION } = await import('@stack/memory');
    let attempts = 0;
    const client = {
      memoryCreateGeneration: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new StackCloudError('memory-conflict', 'stale parent');
        return {
          generation: {
            backupId: 'b-ok',
            userId: 'u',
            generation: 0,
            parentGeneration: null,
            privacyMode: 'standard' as const,
            createdAt: '2026-10-23T00:00:00.000Z',
            payloadSha256: 'sha256:' + 'a'.repeat(64),
            payloadBytes: 0,
            bundleFormatVersion: 'stack-mem-bundle-v2',
            state: 'committed' as const,
            softDeletedAt: null,
          },
        };
      }),
      memoryGetLatest: vi.fn(async () => ({ generation: null })),
    } as unknown as CloudMemoryClient;
    const backend = stackCloudRemoteMemoryBackend(client);

    const main = { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [] };
    const outcome = await pushCanonicalMemory({
      getLocalMain: async () => main,
      getBase: async () => null,
      setLocalMain: async () => undefined,
      setBase: async () => undefined,
      fetchRemote: async () => null,
      publish: async (m, expectedParent) => {
        const meta = await backend.createGeneration({
          backupId: `b-${attempts}`,
          expectedParent,
          privacyMode: 'standard',
          payload: new Uint8Array(),
          bundleFormatVersion: 'stack-mem-bundle-v2',
        });
        return { generation: meta.generation };
      },
      savePendingMerge: async () => undefined,
      clearPendingMerge: async () => undefined,
    });

    expect(attempts).toBe(2);
    expect(outcome.status).toBe('pushed');
  });
});
