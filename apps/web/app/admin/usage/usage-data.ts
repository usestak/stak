import type { SupabaseClient } from '@supabase/supabase-js';

import { rangeStart, type AdminDateRange } from '@/lib/admin-date-range';

export type UsageMetrics = {
  pushesPerDay: { date: string; count: number }[];
  pullsPerDay: { date: string; count: number }[];
  activeMachines: number;
  memoryBackupsCount: number;
  memoryRecoveriesCount: number;
  publicStakPublications: number;
};

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

export const loadUsageMetrics = async (
  db: SupabaseClient,
  range: AdminDateRange,
): Promise<UsageMetrics> => {
  const since = rangeStart(range);

  let eventsQuery = db.from('product_events').select('event_name, created_at');
  if (since) eventsQuery = eventsQuery.gte('created_at', since.toISOString());
  const { data: events, error: eventsError } = await eventsQuery;
  if (eventsError) throw eventsError;

  const rows = (events ?? []) as { event_name: string; created_at: string }[];
  const pushRows = rows.filter((r) => r.event_name === 'cloud.push.succeeded');
  const pullRows = rows.filter((r) => r.event_name === 'cloud.pull.succeeded');
  const memoryRecoveriesCount = rows.filter((r) => r.event_name === 'memory.recovered').length;

  const { data: machineRows, error: machineError } = await db
    .from('machines')
    .select('user_id, machine_id')
    .is('revoked_at', null);
  if (machineError) throw machineError;
  const activeMachines = new Set(
    ((machineRows ?? []) as { machine_id: string }[]).map((m) => m.machine_id),
  ).size;

  const { data: memoryBackupRows, error: backupsError } = await db
    .from('memory_backups')
    .select('id');
  if (backupsError) throw backupsError;

  const { data: publicationRows, error: publicationsError } = await db
    .from('public_stack_versions')
    .select('id');
  if (publicationsError) throw publicationsError;

  return {
    pushesPerDay: bucketByDay(pushRows),
    pullsPerDay: bucketByDay(pullRows),
    activeMachines,
    memoryBackupsCount: (memoryBackupRows ?? []).length,
    memoryRecoveriesCount,
    publicStakPublications: (publicationRows ?? []).length,
  };
};
