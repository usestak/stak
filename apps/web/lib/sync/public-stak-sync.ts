'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import { createSyncController } from './sync-controller';
import { createSupabaseBrowserClient } from '../supabase-browser';

/**
 * Opens one Realtime channel with one `postgres_changes` subscription per `{ table,
 * filter }` pair and routes every event (payload ignored) through `onEvent`. Shared by both
 * public hooks below — the only difference between them is which tables/filters they pass.
 */
function openFilteredChannel(
  client: SupabaseClient,
  name: string,
  subscriptions: Array<{ table: string; filter: string }>,
  onEvent: () => void,
): RealtimeChannel {
  let channel = client.channel(name);
  for (const { table, filter } of subscriptions) {
    channel = channel.on(
      'postgres_changes' as never,
      { event: '*', schema: 'public', table, filter } as never,
      () => onEvent(),
    );
  }
  channel.subscribe();
  return channel;
}

function usePublicRealtimeRefresh(
  subscriptions: Array<{ table: string; filter: string }>,
  channelName: string,
): void {
  const router = useRouter();

  useEffect(() => {
    const controller = createSyncController({
      refresh: () => router.refresh(),
    });
    let client: SupabaseClient | null = null;
    let channel: RealtimeChannel | null = null;
    try {
      client = createSupabaseBrowserClient();
      channel = openFilteredChannel(client, channelName, subscriptions, () =>
        controller.onBroadcastMessage(),
      );
    } catch {
      channel = null;
    }

    return () => {
      controller.dispose();
      if (client && channel) {
        try {
          client.removeChannel(channel);
        } catch {
          // Best-effort cleanup only.
        }
      }
    };
    // `subscriptions` is derived fresh from primitives on every call; the hooks below pass
    // a stable-shaped array each render for a given id/handle, so depending on the
    // primitive `channelName` instead is safe and avoids re-subscribing on every render.
  }, [router, channelName]);
}

/**
 * Mount on the public STAK/Skill detail page (`/[owner]/[slug]`). Subscribes to
 * `public_stacks` and `public_stack_versions`, each narrowly filtered to the one STAK being
 * viewed — anonymous Realtime is safe here because both tables are public-read by design
 * (`using (true)` RLS) and the filter only narrows which already-public rows this tab
 * bothers to listen for, it does not grant any additional access. Covers republish,
 * unpublish, and metadata/version changes: a `router.refresh()` re-runs `getPublicStack`,
 * which already 404s once a STAK is unpublished.
 */
export function usePublicStackSync(stackId: string): void {
  usePublicRealtimeRefresh(
    [
      { table: 'public_stacks', filter: `stack_id=eq.${stackId}` },
      { table: 'public_stack_versions', filter: `stack_id=eq.${stackId}` },
    ],
    `public-stak-sync-${stackId}`,
  );
}

/**
 * Mount on the public profile page (`/[owner]`). Subscribes to `public_stacks` filtered to
 * the viewed owner's handle, so a republish/unpublish/new-publish by that owner refreshes
 * the listing without exposing any other owner's publish activity to this subscriber.
 */
export function usePublicProfileSync(ownerHandle: string): void {
  usePublicRealtimeRefresh(
    [{ table: 'public_stacks', filter: `owner_handle=eq.${ownerHandle}` }],
    `public-profile-sync-${ownerHandle}`,
  );
}
