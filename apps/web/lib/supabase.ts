import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { cloudEnv } from './env';

/**
 * Server-side service-role client. NEVER expose the service role key to the
 * browser, CLI, logs, or API responses; it is used only inside server code
 * after the caller's identity has been derived from an authenticated token or
 * browser session.
 */
export const serviceClient = (): SupabaseClient => {
  const env = cloudEnv();
  return createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
};
