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

type EventRow = {
  event_name: string;
  success: boolean;
  error_code: string | null;
  user_id: string | null;
  created_at: string;
};

const successRateFor = (rows: EventRow[], succeededName: string, failedName: string): number | null => {
  const relevant = rows.filter((r) => r.event_name === succeededName || r.event_name === failedName);
  if (relevant.length === 0) return null;
  const succeeded = relevant.filter((r) => r.event_name === succeededName).length;
  return succeeded / relevant.length;
};

export const loadReliabilityMetrics = async (
  db: SupabaseClient,
  range: AdminDateRange,
): Promise<ReliabilityMetrics> => {
  const since = rangeStart(range) ?? new Date(0);
  const { data, error } = await db
    .from('product_events')
    .select('event_name, success, error_code, user_id, created_at')
    .gte('created_at', since.toISOString());
  if (error) throw error;

  const rows = (data ?? []) as EventRow[];

  const failures = rows.filter((r) => !r.success);
  const grouped = new Map<string, EventRow[]>();
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
    pushSuccessRate: successRateFor(rows, 'cloud.push.succeeded', 'cloud.push.failed'),
    pullSuccessRate: successRateFor(rows, 'cloud.pull.succeeded', 'cloud.pull.failed'),
    recentFailures,
  };
};
