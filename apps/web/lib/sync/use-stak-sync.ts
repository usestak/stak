'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { createSyncController } from './sync-controller';
import { subscribePrivateRealtime } from './realtime-sync';
import {
  SYNC_CHANNEL_NAME,
  isOwnTabSource,
  type SyncMessage,
} from './stak-sync';
import { createSupabaseBrowserClient } from '../supabase-browser';

/**
 * Mount once per authenticated page. In practice this is called from `AppSidebar`, which
 * every authenticated route already renders, so no per-page wiring is needed.
 *
 * Reacts to three external signals, all coalesced through one `createSyncController`, by
 * calling `router.refresh()` (the same mechanism every existing mutation site already
 * uses — there's no partial/cached data to invalidate selectively, every route refetches
 * fresh from CloudService on refresh):
 *  - another tab's `emitSync` broadcast (near-instant, bursts coalesced; this tab's own
 *    emissions are ignored via `isOwnTabSource`)
 *  - an authenticated Supabase Realtime invalidation for one of the five owner-RLS'd
 *    private tables (CLI push, machine check-in, Skill update, project-presence change —
 *    see docs/architecture/realtime-sync-plan.md)
 *  - this tab regaining focus/visibility (debounced fallback for missed signals and for
 *    the window Realtime is disconnected/reconnecting)
 *
 * Realtime is additive, never a hard dependency: if creating the browser client or
 * subscribing throws (e.g. no session yet), the hook stays silent and falls back to
 * BroadcastChannel + focus refresh only — no thrown error, no user-visible error state.
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
          if (isOwnTabSource(event.data.source)) return;
          controller.onBroadcastMessage();
        };
      } catch {
        channel = null;
      }
    }

    let unsubscribeRealtime: (() => void) | null = null;
    try {
      const client = createSupabaseBrowserClient();
      unsubscribeRealtime = subscribePrivateRealtime(client, () => {
        controller.onBroadcastMessage();
      });
    } catch {
      unsubscribeRealtime = null;
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
      try {
        unsubscribeRealtime?.();
      } catch {
        // Best-effort cleanup only.
      }
    };
  }, [router]);
}
