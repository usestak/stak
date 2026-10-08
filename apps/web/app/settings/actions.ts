'use server';

import { getCloudService } from '@/lib/cloud-service';
import { getSessionUser } from '@/lib/session';
import { webAuth } from '@/lib/web-auth';

import { isValidDeleteConfirmation } from './confirm-delete';

/**
 * Deletes every Cloud-held Memory backup + recovery method for the signed-in
 * account (narrow, contract §9) — never native/local Memory, Skills, Projects,
 * or the account itself. Gated on an exact typed confirmation so a stray click
 * can't trigger it.
 */
export async function deleteCloudMemoryAction(
  confirmation: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'You must sign in first.' };
  if (!isValidDeleteConfirmation(confirmation))
    return {
      ok: false,
      error: 'Type the confirmation phrase exactly to continue.',
    };
  try {
    await getCloudService().deleteCloudMemory(webAuth(user.id));
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not delete Cloud Memory. Try again.' };
  }
}
