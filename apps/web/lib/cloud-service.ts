import { createCloudService, type CloudService, type ProductEvent } from '@stack/cloud-server';

import { supabaseBlobStore } from './blob';
import { cloudEnv } from './env';
import { supabaseRemoteMemoryBackend } from './memory-backend';
import { supabaseRepository } from './repository';
import { serviceClient } from './supabase';

let cached: CloudService | undefined;

/**
 * Maps a ProductEvent onto product_events' column shape. Exported and
 * tested in isolation (rather than only through the full getCloudService()
 * singleton) since the singleton caches across calls and isn't easily
 * reset between tests.
 */
export const productEventToRow = (event: ProductEvent) => ({
  user_id: event.userId,
  event_name: event.eventName,
  machine_id: event.machineId ?? null,
  success: event.success,
  error_code: event.errorCode ?? null,
  metadata: event.metadata ?? null,
});

/** Lazily build the shared CloudService from server-only configuration. */
export const getCloudService = (): CloudService => {
  if (!cached) {
    const env = cloudEnv();
    cached = createCloudService({
      repository: supabaseRepository(),
      blobStore: supabaseBlobStore(),
      appUrl: env.appUrl,
      ticketSecret: env.ticketSecret,
      maxSnapshotBytes: env.maxSnapshotBytes,
      memoryBackendFor: (userId) => supabaseRemoteMemoryBackend(userId),
      recordEvent: async (event) => {
        const { error } = await serviceClient()
          .from('product_events')
          .insert(productEventToRow(event));
        if (error) console.error('[product_events] insert failed', error);
      },
    });
  }
  return cached;
};
