'use server';

import { getCloudService } from '@/lib/cloud-service';
import { supabaseServerClient } from '@/lib/supabase-server';

export async function approveCli(
  userCode: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await supabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'You must sign in first.' };
  try {
    const metadata = (user.user_metadata ?? {}) as Record<string, string>;
    await getCloudService().approveCliAuth({
      userCode,
      profile: {
        userId: user.id,
        githubUsername: metadata.user_name,
        displayName: metadata.full_name ?? metadata.name,
        avatarUrl: metadata.avatar_url,
      },
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Approval failed.',
    };
  }
}
