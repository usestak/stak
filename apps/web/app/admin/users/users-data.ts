import type { SupabaseClient } from '@supabase/supabase-js';

import { loadActiveMachinesByUser } from '@/lib/admin-metrics';

export type AdminUserRow = {
  userId: string;
  displayName: string;
  joinedAt: string;
  pushCount: number;
  machineCount: number;
  feedbackCount: number;
};

type ProfileRow = { user_id: string; display_name: string | null; github_username: string | null; created_at: string };

// A hard cap until a proper server-side aggregate (RPC/view) replaces this
// per-table-fetch approach — see Phase 2 final-review Important #4. Keeps a
// pathological user count from pulling an unbounded number of rows into Node.
const MAX_ROWS = 500;

// ilike's pattern syntax treats % and _ as wildcards; escape them so a
// search term containing either matches literally instead of surprisingly
// matching extra rows.
const escapeLikePattern = (value: string): string => value.replace(/[%_]/g, (c) => `\\${c}`);

export const loadUsers = async (db: SupabaseClient, search?: string): Promise<AdminUserRow[]> => {
  let profilesQuery = db
    .from('profiles')
    .select('user_id, display_name, github_username, created_at')
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);
  if (search) {
    // Double-quoted so a search term containing a comma or parenthesis
    // (PostgREST's .or() filter-string delimiters) is treated as a literal
    // character to match, not parsed as part of the filter syntax itself.
    const pattern = `"%${escapeLikePattern(search).replace(/"/g, '\\"')}%"`;
    profilesQuery = profilesQuery.or(`display_name.ilike.${pattern},github_username.ilike.${pattern}`);
  }
  const { data: profiles, error: profilesError } = await profilesQuery;
  if (profilesError) throw profilesError;

  const { data: versions, error: versionsError } = await db
    .from('environment_versions')
    .select('user_id')
    .limit(MAX_ROWS * 20);
  if (versionsError) throw versionsError;

  const { data: feedbackRows, error: feedbackError } = await db
    .from('feedback')
    .select('user_id')
    .limit(MAX_ROWS * 20);
  if (feedbackError) throw feedbackError;

  const machinesByUser = await loadActiveMachinesByUser(db);

  const countBy = (rows: { user_id: string }[] | null) => {
    const counts = new Map<string, number>();
    for (const row of rows ?? []) counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
    return counts;
  };

  const pushCounts = countBy(versions as { user_id: string }[] | null);
  const feedbackCounts = countBy((feedbackRows ?? []).filter((r: { user_id: string | null }) => r.user_id) as { user_id: string }[]);

  return ((profiles ?? []) as ProfileRow[]).map((p) => ({
    userId: p.user_id,
    displayName: p.display_name ?? p.github_username ?? 'Unnamed',
    joinedAt: p.created_at,
    pushCount: pushCounts.get(p.user_id) ?? 0,
    machineCount: machinesByUser.get(p.user_id)?.size ?? 0,
    feedbackCount: feedbackCounts.get(p.user_id) ?? 0,
  }));
};
