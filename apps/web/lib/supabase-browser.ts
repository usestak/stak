'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * The browser's first-ever direct Supabase connection (Realtime). Deliberately reads only
 * the two public `NEXT_PUBLIC_*` vars straight from `process.env` and never imports the
 * shared `./env` module's combined config helper, which also reads two server-only
 * secret vars in the same function body — importing it here would risk pulling those
 * secret-reading code paths into the client bundle. Reuses the existing anon key and the
 * session cookie `@supabase/ssr`'s server client already set on login; no new secret, no
 * new auth flow.
 */
export function createSupabaseBrowserClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl) {
    throw new Error(
      'Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL',
    );
  }
  if (!supabaseAnonKey) {
    throw new Error(
      'Missing required environment variable: NEXT_PUBLIC_SUPABASE_ANON_KEY',
    );
  }
  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
