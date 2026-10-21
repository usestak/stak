import type { SupabaseClient } from '@supabase/supabase-js';

import { rangeStart, type AdminDateRange } from '@/lib/admin-date-range';

export type ReliabilityMetrics = {
  pushSuccessRate: number | null;
  pullSuccessRate: number | null;
  recentFailures: {
    operation: string;
    errorCode: string;
    count: number;
    affectedUsers: number;
    firstSeen: string;
    lastSeen: string;
  }[];
};

type FailureRow = {
  event_name: string;
  error_code: string | null;
  user_id: string | null;
  created_at: string;
};

// Hosted Supabase/PostgREST caps any single response at 1000 rows by
// default (no max_rows override exists in this repo's supabase/ config) --
// a limit() higher than that does NOT raise the real ceiling. Once
// failures-in-range exceed 1000, the oldest ones silently drop from
// recentFailures' counts/firstSeen (ordered newest-first) -- the admin has
// no on-page indication this happened. Accepted limitation until a proper
// server-side aggregate (RPC/view) replaces this per-table-fetch approach,
// same category of exception as usage-data.ts/users-data.ts's row caps
// (Phase 2/3 final reviews). Success rates don't need this (they're
// computed via head:true counts below, with no row cap); only the
// per-failure grouping genuinely needs row-level data.
const MAX_FAILURE_ROWS = 1000;

const countFor = async (
  db: SupabaseClient,
  eventName: string,
  since: Date,
): Promise<number> => {
  const { count, error } = await db
    .from('product_events')
    .select('id', { count: 'exact', head: true })
    .eq('event_name', eventName)
    .gte('created_at', since.toISOString());
  if (error) throw error;
  return count ?? 0;
};

const rateFrom = (succeeded: number, failed: number): number | null =>
  succeeded + failed === 0 ? null : succeeded / (succeeded + failed);

export const loadReliabilityMetrics = async (
  db: SupabaseClient,
  range: AdminDateRange,
): Promise<ReliabilityMetrics> => {
  const since = rangeStart(range) ?? new Date(0);

  const [pushSucceeded, pushFailed, pullSucceeded, pullFailed] = await Promise.all([
    countFor(db, 'cloud.push.succeeded', since),
    countFor(db, 'cloud.push.failed', since),
    countFor(db, 'cloud.pull.succeeded', since),
    countFor(db, 'cloud.pull.failed', since),
  ]);

  // Explicitly `success = false` at the database level (not a JS `!r.success`
  // check) -- the column allows null, and a future event written with
  // success left null should not silently show up as a counted failure.
  const { data, error } = await db
    .from('product_events')
    .select('event_name, error_code, user_id, created_at')
    .eq('success', false)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(MAX_FAILURE_ROWS);
  if (error) throw error;

  const failures = (data ?? []) as FailureRow[];
  const grouped = new Map<string, FailureRow[]>();
  for (const row of failures) {
    const key = `${row.event_name}::${row.error_code ?? 'unknown'}`;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }

  const recentFailures = [...grouped.entries()]
    .map(([, list]) => {
      const sorted = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));
      return {
        operation: sorted[0]!.event_name,
        errorCode: sorted[0]!.error_code ?? 'unknown',
        count: sorted.length,
        affectedUsers: new Set(sorted.map((r) => r.user_id).filter(Boolean)).size,
        firstSeen: sorted[0]!.created_at,
        lastSeen: sorted[sorted.length - 1]!.created_at,
      };
    })
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));

  return {
    pushSuccessRate: rateFrom(pushSucceeded, pushFailed),
    pullSuccessRate: rateFrom(pullSucceeded, pullFailed),
    recentFailures,
  };
};
