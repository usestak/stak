'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

import { createSyncController, type SyncController } from './sync-controller';
import { subscribePrivateRealtime } from './realtime-sync';
import {
  SYNC_CHANNEL_NAME,
  isOwnTabSource,
  type SyncMessage,
} from './stak-sync';
import { createSupabaseBrowserClient } from '../supabase-browser';

/** Focus/visibility refreshes are skipped while the page's data is younger than this. */
export const FOCUS_REFRESH_MIN_INTERVAL_MS = 30_000;

export type UseStakSyncOptions = {
  /** Listen only while true; the subscription survives navigations as long as it stays on. */
  enabled?: boolean;
  /** Changes whenever the page renders fresh server data (e.g. the pathname). */
  freshKey?: string;
  focusMinIntervalMs?: number;
};

/**
 * Mounted once, from the root layout (`StakSyncMount`), so the Realtime channel and
 * listeners persist across navigations instead of being torn down and rejoined per page.
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
export function useStakSync({
  enabled = true,
  freshKey,
  focusMinIntervalMs = FOCUS_REFRESH_MIN_INTERVAL_MS,
}: UseStakSyncOptions = {}): void {
  const router = useRouter();
  // Read through a ref so the subscription never depends on the router object's identity.
  const routerRef = useRef(router);
  routerRef.current = router;
  const controllerRef = useRef<SyncController | null>(null);

  useEffect(() => {
    controllerRef.current?.markFresh();
  }, [freshKey]);

  useEffect(() => {
    if (!enabled) return;
    const controller = createSyncController({
      refresh: () => routerRef.current.refresh(),
      focusMinIntervalMs,
    });
    controller.markFresh();
    controllerRef.current = controller;

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
      if (controllerRef.current === controller) controllerRef.current = null;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      channel?.close();
      try {
        unsubscribeRealtime?.();
      } catch {
        // Best-effort cleanup only.
      }
    };
  }, [enabled, focusMinIntervalMs]);
}
