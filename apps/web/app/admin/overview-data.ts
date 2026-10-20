import type { SupabaseClient } from '@supabase/supabase-js';

import { rangeStart, type AdminDateRange } from '@/lib/admin-date-range';

export type OverviewMetrics = {
  totalUsers: number;
  newUsers: number;
  activatedUsers: number;
  activationRate: number | null;
  portableUsers: number;
  newFeedback: number;
  openFeedback: number;
  pushPullSuccessRate: 'unavailable';
};

/**
 * Overview metrics computed entirely from existing tables (no product_events
 * yet — that lands in Phase 3). pushPullSuccessRate is explicitly marked
 * unavailable rather than faked from partial data.
 */
export const loadOverviewMetrics = async (
  db: SupabaseClient,
  range: AdminDateRange,
): Promise<OverviewMetrics> => {
  const since = rangeStart(range);

  const { count: totalUsers } = await db.from('profiles').select('user_id', { count: 'exact', head: true });

  const newUsersQuery = db.from('profiles').select('user_id', { count: 'exact', head: true });
  const { count: newUsers } = await (since ? newUsersQuery.gte('created_at', since.toISOString()) : newUsersQuery);

  const pushesQuery = db.from('environment_versions').select('user_id');
  const { data: pushRows } = await (since ? pushesQuery.gte('created_at', since.toISOString()) : pushesQuery);
  const activatedUserIds = new Set(((pushRows ?? []) as { user_id: string }[]).map((r) => r.user_id));

  const { data: machineRows } = await db.from('machines').select('user_id, machine_id').is('revoked_at', null);
  const machinesByUser = new Map<string, Set<string>>();
  for (const row of (machineRows ?? []) as { user_id: string; machine_id: string }[]) {
    const set = machinesByUser.get(row.user_id) ?? new Set<string>();
    set.add(row.machine_id);
    machinesByUser.set(row.user_id, set);
  }
  const portableUsers = [...machinesByUser.values()].filter((s) => s.size >= 2).length;

  const { count: newFeedback } = await db
    .from('feedback')
    .select('id', { count: 'exact', head: true })
    .in('status', ['new']);
  const { count: openFeedback } = await db
    .from('feedback')
    .select('id', { count: 'exact', head: true })
    .in('status', ['new', 'reviewing']);

  const total = totalUsers ?? 0;
  const activatedUsers = activatedUserIds.size;

  return {
    totalUsers: total,
    newUsers: newUsers ?? 0,
    activatedUsers,
    activationRate: total > 0 ? activatedUsers / total : null,
    portableUsers,
    newFeedback: newFeedback ?? 0,
    openFeedback: openFeedback ?? 0,
    pushPullSuccessRate: 'unavailable',
  };
};
