import type { SupabaseClient } from '@supabase/supabase-js';

export type AdminUserRow = {
  userId: string;
  displayName: string;
  joinedAt: string;
  pushCount: number;
  machineCount: number;
  feedbackCount: number;
};

type ProfileRow = { user_id: string; display_name: string | null; github_username: string | null; created_at: string };

export const loadUsers = async (db: SupabaseClient, search?: string): Promise<AdminUserRow[]> => {
  const profilesQuery = db.from('profiles').select('user_id, display_name, github_username, created_at');
  const { data: profiles } = await (search ? profilesQuery.ilike('display_name', `%${search}%`) : profilesQuery);

  const { data: versions } = await db.from('environment_versions').select('user_id');
  const { data: machines } = await db.from('machines').select('user_id, machine_id');
  const { data: feedbackRows } = await db.from('feedback').select('user_id');

  const countBy = (rows: { user_id: string }[] | null) => {
    const counts = new Map<string, number>();
    for (const row of rows ?? []) counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
    return counts;
  };

  const pushCounts = countBy(versions as { user_id: string }[] | null);
  const feedbackCounts = countBy((feedbackRows ?? []).filter((r: { user_id: string | null }) => r.user_id) as { user_id: string }[]);

  const machineCounts = new Map<string, Set<string>>();
  for (const row of (machines ?? []) as { user_id: string; machine_id: string }[]) {
    const set = machineCounts.get(row.user_id) ?? new Set<string>();
    set.add(row.machine_id);
    machineCounts.set(row.user_id, set);
  }

  return ((profiles ?? []) as ProfileRow[]).map((p) => ({
    userId: p.user_id,
    displayName: p.display_name ?? p.github_username ?? 'Unnamed',
    joinedAt: p.created_at,
    pushCount: pushCounts.get(p.user_id) ?? 0,
    machineCount: machineCounts.get(p.user_id)?.size ?? 0,
    feedbackCount: feedbackCounts.get(p.user_id) ?? 0,
  }));
};
