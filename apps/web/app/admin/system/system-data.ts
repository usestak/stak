import type { SupabaseClient } from '@supabase/supabase-js';

export type SystemStatus = {
  webVersion: string;
  cliVersion: string;
  dbConnected: boolean;
  recentFailureCount: number;
};

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const loadSystemStatus = async (
  db: SupabaseClient,
  webVersion: string,
  cliVersion: string,
): Promise<SystemStatus> => {
  // Connectivity check: a trivial, cheap read. A connectivity FAILURE is a
  // real (if degraded) answer for this page to show -- it must not throw
  // and take the whole page down with it, unlike every other admin loader
  // in this project (which deliberately throws on error). This is the one
  // intentional exception, because "is the DB reachable" is itself the
  // thing being measured.
  const { error: connectError } = await db.from('profiles').select('user_id').limit(1);
  const dbConnected = !connectError;

  let recentFailureCount = 0;
  if (dbConnected) {
    const since = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
    const { count, error } = await db
      .from('product_events')
      .select('id', { count: 'exact', head: true })
      .eq('success', false)
      .gte('created_at', since);
    if (!error) recentFailureCount = count ?? 0;
  }

  return { webVersion, cliVersion, dbConnected, recentFailureCount };
};
