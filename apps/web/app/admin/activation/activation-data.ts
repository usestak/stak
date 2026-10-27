import type { SupabaseClient } from '@supabase/supabase-js';

import {
  countPortableUsers,
  loadActiveMachinesByUser,
} from '@/lib/admin-metrics';

export type ActivationFunnel = {
  accounts: number;
  cliAuthenticated: number;
  firstPush: number;
  portable: number;
};

const distinctUserCount = (rows: { user_id: string }[] | null): number =>
  new Set((rows ?? []).map((r) => r.user_id)).size;

export const loadActivationFunnel = async (
  db: SupabaseClient,
): Promise<ActivationFunnel> => {
  // user_id is profiles' primary key, so a row count is already a distinct
  // count -- no need to pull rows just to dedupe them.
  const { count: accounts, error: accountsError } = await db
    .from('profiles')
    .select('user_id', { count: 'exact', head: true });
  if (accountsError) throw accountsError;

  const { data: tokens, error: tokensError } = await db
    .from('cli_tokens')
    .select('user_id');
  if (tokensError) throw tokensError;

  const { data: versions, error: versionsError } = await db
    .from('environment_versions')
    .select('user_id');
  if (versionsError) throw versionsError;

  const machinesByUser = await loadActiveMachinesByUser(db);
  const portable = countPortableUsers(machinesByUser);

  return {
    accounts: accounts ?? 0,
    cliAuthenticated: distinctUserCount(tokens as { user_id: string }[] | null),
    firstPush: distinctUserCount(versions as { user_id: string }[] | null),
    portable,
  };
};
