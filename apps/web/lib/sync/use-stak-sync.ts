'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { createSyncController } from './sync-controller';
import { SYNC_CHANNEL_NAME, type SyncMessage } from './stak-sync';

/**
 * Mount once per authenticated page. In practice this is called from `AppSidebar`, which
 * every authenticated route already renders, so no per-page wiring is needed.
 *
 * Reacts to two external signals by calling `router.refresh()` (the same mechanism every
 * existing mutation site already uses — there's no partial/cached data to invalidate
 * selectively, every route refetches fresh from CloudService on refresh):
 *  - another tab's `emitSync` broadcast (near-instant, bursts coalesced)
 *  - this tab regaining focus/visibility (debounced fallback for missed broadcasts and for
 *    external changes — CLI, another machine, another device — that this phase doesn't
 *    push to the browser yet; see Realtime phase in the project's sync-architecture doc)
 *
 * This hook never calls `emitSync` itself, so reacting to a signal here cannot cause a
 * rebroadcast loop.
 */
export function useStakSync(): void {
  const router = useRouter();

  useEffect(() => {
    const controller = createSyncController({
      refresh: () => router.refresh(),
    });

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
        channel.onmessage = (event: MessageEvent<SyncMessage>) => {
          if (!event.data || !Array.isArray(event.data.domains)) return;
          controller.onBroadcastMessage();
        };
      } catch {
        channel = null;
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') controller.onVisible();
    };
    const onFocus = () => controller.onFocus();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);

    return () => {
      controller.dispose();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      channel?.close();
    };
  }, [router]);
}
