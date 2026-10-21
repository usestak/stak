// apps/web/lib/admin.ts
import { getSessionUser, type WebUser } from './session';
import { serviceClient } from './supabase';

export type AdminRole = 'owner' | 'admin';
export type AdminUser = WebUser & { role: AdminRole };

/**
 * Resolve the signed-in user AND verify admin membership server-side.
 * Returns null for a logged-out visitor, a logged-in non-admin, or any
 * lookup failure (including a thrown error, e.g. a misconfigured service
 * client or a transient query error) — callers must treat null as "no
 * admin access" in every case, never distinguish the reasons. A throw here
 * would otherwise surface as a 500 error page instead of the intended 404,
 * which leaks that the route exists.
 */
export const getAdminUser = async (): Promise<AdminUser | null> => {
  try {
    const user = await getSessionUser();
    if (!user) return null;

    const { data, error } = await serviceClient()
      .from('admin_users')
      .select('role')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error || !data) return null;

    return { ...user, role: data.role as AdminRole };
  } catch {
    return null;
  }
};
