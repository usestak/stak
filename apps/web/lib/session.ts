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
 */
export const getSessionUser = async (): Promise<WebUser | null> => {
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
};

export const displayNameOf = (user: WebUser): string =>
  user.displayName ?? user.githubUsername ?? 'Signed in';
