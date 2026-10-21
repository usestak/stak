import { cache } from 'react';

import { supabaseServerClient } from './supabase-server';

export type WebUser = {
  id: string;
  githubUsername?: string;
  displayName?: string;
  avatarUrl?: string;
};

/**
 * Resolve the signed-in browser-session user (GitHub OAuth via Supabase), or
 * null when logged out. Identity comes only from the verified session — never
 * from client input — and is what scopes every private Cloud query.
 *
 * `cache()`-wrapped: `supabase.auth.getUser()` validates the session against Supabase's auth
 * server over the network on every call (unlike `getSession()`, which only reads the local
 * JWT) — called from 20+ files, often more than once per request (e.g. a layout AND the page
 * it wraps). Takes no arguments, so there's no argument-identity subtlety to worry about; this
 * is a safe, unconditional per-request dedup.
 */
export const getSessionUser = cache(async (): Promise<WebUser | null> => {
  const supabase = await supabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const metadata = (user.user_metadata ?? {}) as Record<string, string>;
  return {
    id: user.id,
    ...(metadata.user_name ? { githubUsername: metadata.user_name } : {}),
    ...(metadata.full_name || metadata.name
      ? { displayName: metadata.full_name ?? metadata.name }
      : {}),
    ...(metadata.avatar_url ? { avatarUrl: metadata.avatar_url } : {}),
  };
});

export const displayNameOf = (user: WebUser): string =>
  user.displayName ?? user.githubUsername ?? 'Signed in';
