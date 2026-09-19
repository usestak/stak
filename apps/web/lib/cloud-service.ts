import { createCloudService, type CloudService } from '@stack/cloud-server';

import { supabaseBlobStore } from './blob';
import { cloudEnv } from './env';
import { supabaseRepository } from './repository';

let cached: CloudService | undefined;

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
    });
  }
  return cached;
};
