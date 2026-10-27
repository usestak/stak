import {
  createCloudService,
  type CloudService,
  type ProductEvent,
} from '@stack/cloud-server';
import { after } from 'next/server';
import { cache } from 'react';

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
    const service = createCloudService({
      repository: supabaseRepository(),
      blobStore: supabaseBlobStore(),
      appUrl: env.appUrl,
      ticketSecret: env.ticketSecret,
      maxSnapshotBytes: env.maxSnapshotBytes,
      memoryBackendFor: (userId) => supabaseRemoteMemoryBackend(userId),
      recordEvent: (event) => {
        // cloud-server already fires this with `void` (fire-and-forget, so
        // it can't add latency to the push/pull response) -- but on
        // serverless, a bare un-awaited write risks the function instance
        // being torn down before the network write lands, silently
        // dropping the event. next/server's after() runs this once the
        // response has been sent, using the platform's own mechanism
        // (waitUntil on Vercel) to keep the instance alive until it
        // finishes, rather than racing it against teardown.
        after(async () => {
          const { error } = await serviceClient()
            .from('product_events')
            .insert(productEventToRow(event));
          if (error) console.error('[product_events] insert failed', error);
        });
      },
    });
    cached = {
      ...service,
      // `cache()`-wrapped: these three reads are each independently called by multiple
      // loaders within the SAME request (every page's own data loader, plus
      // `loadSidebarSummary` for the sidebar badges on every route) — without this, each
      // request paid for the identical Cloud/Supabase read twice. `cache()` is request-scoped
      // (via the App Router's render context) even though it's set up once here on a
      // process-lifetime singleton — defining it once at this call site, not per-request, is
      // the correct and intended way to use it. Relies on `webAuth(userId)` itself being
      // `cache()`-wrapped (see lib/web-auth.ts) so the `auth` argument is the same object
      // reference across callers within one request — React's `cache()` keys non-primitive
      // arguments by reference, not deep equality.
      getOverview: cache(service.getOverview),
      listUserStacks: cache(service.listUserStacks),
      getMachinesReadModel: cache(service.getMachinesReadModel),
      // Public pages read these in both `generateMetadata` and the page body. Primitive
      // (owner/slug/handle) arguments, so cache() keys them by value.
      getPublicStack: cache(service.getPublicStack),
      getPublicProfile: cache(service.getPublicProfile),
    };
  }
  return cached;
};
