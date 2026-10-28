import type { SupabaseClient } from '@supabase/supabase-js';

type MachineRow = { user_id: string; machine_id: string };

/**
 * Non-revoked machines grouped by user. Every admin page that needs a
 * "portable user" or "machine count" figure must go through this helper —
 * it is the single place the revoked_at filter is applied, so Overview,
 * Activation, and Users can't silently drift on what counts as an active
 * machine (they did, before this helper existed).
 */
export const loadActiveMachinesByUser = async (
  db: SupabaseClient,
): Promise<Map<string, Set<string>>> => {
  const { data, error } = await db
    .from('machines')
    .select('user_id, machine_id')
    .is('revoked_at', null);
  if (error) throw error;

  const machinesByUser = new Map<string, Set<string>>();
  for (const row of (data ?? []) as MachineRow[]) {
    const set = machinesByUser.get(row.user_id) ?? new Set<string>();
    set.add(row.machine_id);
    machinesByUser.set(row.user_id, set);
  }
  return machinesByUser;
};

/** A portable user has active (non-revoked) machines in >=2 distinct machine_ids. */
export const countPortableUsers = (
  machinesByUser: Map<string, Set<string>>,
): number => [...machinesByUser.values()].filter((s) => s.size >= 2).length;
