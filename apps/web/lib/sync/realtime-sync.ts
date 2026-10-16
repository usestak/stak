'use client';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { SyncDomain } from './stak-sync';

/**
 * Private table → sync-domain mapping for the authenticated Realtime invalidation channel.
 * Every table here already has an owner-only `auth.uid() = user_id` SELECT policy (see
 * docs/architecture/realtime-sync-plan.md §3) — RLS, not a client filter, is the
 * authorization boundary, so no `filter` option is used per subscription.
 *
 * `public.memory_backups` is deliberately excluded: it holds `wrapped_dek` key material
 * and a `postgres_changes` event ships the entire row with no column projection. The
 * `memory` domain's freshness need is already served by `machines.memory_backed_up` below.
 */
const PRIVATE_TABLE_DOMAINS: Record<string, SyncDomain[]> = {
  user_stacks: ['staks', 'publication', 'sidebar', 'overview'],
  user_stack_versions: ['staks', 'publication', 'sidebar', 'overview'],
  machines: ['machines', 'memory', 'sidebar', 'overview'],
  machine_skill_versions: ['skills', 'sidebar', 'overview'],
  machine_project_presence: ['projects', 'sidebar', 'overview'],
};

export const PRIVATE_REALTIME_TABLES: string[] = Object.keys(
  PRIVATE_TABLE_DOMAINS,
);

/**
 * Opens one Realtime channel with one `postgres_changes` subscription per private table.
 * The row payload is never read — `onInvalidate` only ever receives the domain list for the
 * table that changed, per the invalidation-only principle. Returns an unsubscribe function;
 * callers must call it on unmount/cleanup.
 */
export function subscribePrivateRealtime(
  client: SupabaseClient,
  onInvalidate: (domains: SyncDomain[]) => void,
): () => void {
  let channel = client.channel('stak-sync-private');
  for (const [table, domains] of Object.entries(PRIVATE_TABLE_DOMAINS)) {
    channel = channel.on(
      'postgres_changes' as never,
      { event: '*', schema: 'public', table } as never,
      () => onInvalidate(domains),
    );
  }
  channel.subscribe();
  return () => {
    client.removeChannel(channel);
  };
}
