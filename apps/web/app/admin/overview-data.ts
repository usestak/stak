import type { SupabaseClient } from '@supabase/supabase-js';

import { rangeStart, type AdminDateRange } from '@/lib/admin-date-range';
import { countPortableUsers, loadActiveMachinesByUser } from '@/lib/admin-metrics';

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
 *
 * activatedUsers/activationRate are deliberately NOT filtered by the
 * selected date range: "activated" means "has ever made a first successful
 * push" (the spec's fixed definition), so the denominator and numerator are
 * both all-time counts. Only newUsers reflects the range. Mixing the two
 * (range-filtered numerator over an all-time denominator) previously made
 * the rate measure something else entirely once a range narrower than "all"
 * was selected.
 */
export const loadOverviewMetrics = async (
  db: SupabaseClient,
  range: AdminDateRange,
): Promise<OverviewMetrics> => {
  const since = rangeStart(range);

  const { count: totalUsers, error: totalUsersError } = await db
    .from('profiles')
    .select('user_id', { count: 'exact', head: true });
  if (totalUsersError) throw totalUsersError;

  const newUsersQuery = db.from('profiles').select('user_id', { count: 'exact', head: true });
  const { count: newUsers, error: newUsersError } = await (since
    ? newUsersQuery.gte('created_at', since.toISOString())
    : newUsersQuery);
  if (newUsersError) throw newUsersError;

  const { data: pushRows, error: pushRowsError } = await db
    .from('environment_versions')
    .select('user_id');
  if (pushRowsError) throw pushRowsError;
  const activatedUserIds = new Set(((pushRows ?? []) as { user_id: string }[]).map((r) => r.user_id));

  const machinesByUser = await loadActiveMachinesByUser(db);
  const portableUsers = countPortableUsers(machinesByUser);

  const { count: newFeedback, error: newFeedbackError } = await db
    .from('feedback')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'new');
  if (newFeedbackError) throw newFeedbackError;

  const { count: openFeedback, error: openFeedbackError } = await db
    .from('feedback')
    .select('id', { count: 'exact', head: true })
    .in('status', ['new', 'reviewing']);
  if (openFeedbackError) throw openFeedbackError;

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
