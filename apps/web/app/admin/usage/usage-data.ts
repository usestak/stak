import type { SupabaseClient } from '@supabase/supabase-js';

import { rangeStart, type AdminDateRange } from '@/lib/admin-date-range';
import { loadActiveMachinesByUser } from '@/lib/admin-metrics';

export type UsageMetrics = {
  pushesPerDay: { date: string; count: number }[];
  pullsPerDay: { date: string; count: number }[];
  activeMachines: number;
  memoryBackupsCount: number;
  /** No code path emits 'memory.recovered' yet -- always 'not-instrumented'
   * rather than a real-looking 0, matching the CLI-version-tile convention
   * (never fake a metric with no real data source). */
  memoryRecoveriesCount: number | 'not-instrumented';
  publicStakPublications: number;
};

// Hosted Supabase/PostgREST caps any single response at 1000 rows by
// default (no max_rows override exists in this repo's supabase/ config) --
// a limit() higher than that does NOT raise the real ceiling, it just
// documents the intent. Once events-in-range exceed 1000, the oldest days
// in the bucketed output silently drop (ordered newest-first). Accepted
// limitation until a proper server-side aggregate (RPC/view) replaces this
// per-table-fetch approach -- same category of exception as users-data.ts's
// row cap (Phase 2 final review), carried forward rather than silently
// re-introduced. Unlike a plain count query, per-day bucketing needs the
// actual rows, not just a total, so a head:true count can't replace this.
const MAX_EVENT_ROWS = 1000;

const bucketByDay = (
  rows: { created_at: string }[],
): { date: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const date = row.created_at.slice(0, 10);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
};

type EventRow = { event_name: string; created_at: string; metadata: { replayed?: boolean } | null };

export const loadUsageMetrics = async (
  db: SupabaseClient,
  range: AdminDateRange,
): Promise<UsageMetrics> => {
  const since = rangeStart(range);

  // Scoped to exactly the event names this page cares about (not every
  // product_events row ever written) so the per-page row cap goes further
  // and so a pathological volume of some unrelated event type can't starve
  // this query's row budget.
  let eventsQuery = db
    .from('product_events')
    .select('event_name, created_at, metadata')
    .in('event_name', ['cloud.push.succeeded', 'cloud.pull.succeeded'])
    .order('created_at', { ascending: false })
    .limit(MAX_EVENT_ROWS);
  if (since) eventsQuery = eventsQuery.gte('created_at', since.toISOString());
  const { data: events, error: eventsError } = await eventsQuery;
  if (eventsError) throw eventsError;

  const rows = (events ?? []) as EventRow[];
  // "cloud.pull.succeeded" also fires for push's and `stak status`'s
  // internal precondition read (packages/core's cloud-push.ts/
  // cloud-status.ts both call the same client.getEnvironment('main') the
  // real pull command uses) -- the server has no signal to tell these
  // apart. Labelled accordingly in the page rather than presented as a
  // pure pull count. A retried push (idempotency replay, metadata.replayed)
  // is excluded from pushesPerDay so a retry isn't double-counted as two
  // pushes.
  const pushRows = rows.filter(
    (r) => r.event_name === 'cloud.push.succeeded' && !r.metadata?.replayed,
  );
  const pullRows = rows.filter((r) => r.event_name === 'cloud.pull.succeeded');

  const machinesByUser = await loadActiveMachinesByUser(db);
  const activeMachines = new Set(
    [...machinesByUser.values()].flatMap((machineIds) => [...machineIds]),
  ).size;

  // 'committed' only: 'pending'/'retired' generations aren't a completed
  // backup from the user's point of view.
  const { count: memoryBackupsCount, error: backupsError } = await db
    .from('memory_backups')
    .select('backup_id', { count: 'exact', head: true })
    .eq('state', 'committed');
  if (backupsError) throw backupsError;

  const { count: publicStakPublications, error: publicationsError } = await db
    .from('public_stack_versions')
    .select('version_id', { count: 'exact', head: true });
  if (publicationsError) throw publicationsError;

  return {
    pushesPerDay: bucketByDay(pushRows),
    pullsPerDay: bucketByDay(pullRows),
    activeMachines,
    memoryBackupsCount: memoryBackupsCount ?? 0,
    memoryRecoveriesCount: 'not-instrumented',
    publicStakPublications: publicStakPublications ?? 0,
  };
};
