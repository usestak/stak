import type { SupabaseClient } from '@supabase/supabase-js';

export type ActivationFunnel = {
  accounts: number;
  cliAuthenticated: number;
  firstPush: number;
  portable: number;
};

const distinctUserCount = (rows: { user_id: string }[] | null): number =>
  new Set((rows ?? []).map((r) => r.user_id)).size;

export const loadActivationFunnel = async (db: SupabaseClient): Promise<ActivationFunnel> => {
  const { data: profiles } = await db.from('profiles').select('user_id');
  const { data: tokens } = await db.from('cli_tokens').select('user_id');
  const { data: versions } = await db.from('environment_versions').select('user_id');
  const { data: machines } = await db.from('machines').select('user_id, machine_id');

  const machinesByUser = new Map<string, Set<string>>();
  for (const row of (machines ?? []) as { user_id: string; machine_id: string }[]) {
    const set = machinesByUser.get(row.user_id) ?? new Set<string>();
    set.add(row.machine_id);
    machinesByUser.set(row.user_id, set);
  }
  const portable = [...machinesByUser.values()].filter((s) => s.size >= 2).length;

  return {
    accounts: distinctUserCount(profiles as { user_id: string }[] | null),
    cliAuthenticated: distinctUserCount(tokens as { user_id: string }[] | null),
    firstPush: distinctUserCount(versions as { user_id: string }[] | null),
    portable,
  };
};
