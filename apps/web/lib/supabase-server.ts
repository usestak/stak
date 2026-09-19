import { cookies } from 'next/headers';

import { createServerClient } from '@supabase/ssr';

import { cloudEnv } from './env';

/**
 * Browser-session Supabase client for auth pages/route handlers. Uses the anon
 * key and the caller's cookies; the derived user identity is what authorizes CLI
 * approval — the CLI never asserts its own user id.
 */
export const supabaseServerClient = async () => {
  const cookieStore = await cookies();
  const env = cloudEnv();
  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list)
            cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component render; cookies are read-only there.
        }
      },
    },
  });
};
