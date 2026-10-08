'use server';

import { CloudServiceError } from '@stack/cloud-server';

import { getCloudService } from '../../lib/cloud-service';
import { getSessionUser } from '../../lib/session';

const notSignedIn = { ok: false as const, error: 'You must sign in first.' };

/**
 * Revoke a machine's bound token (contract §12). Server-side only: this never reaches the
 * machine itself — it just stops that token from authenticating future CLI requests. The row,
 * its Skills/Projects/Memory facts, and Cloud data are all left untouched.
 */
export async function revokeMachineAction(input: {
  machineId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    await getCloudService().revokeMachine(
      { userId: user.id, tokenId: 'web-session' },
      input.machineId,
    );
    return { ok: true };
  } catch (error) {
    if (
      error instanceof CloudServiceError &&
      error.code === 'machine-not-found'
    )
      return {
        ok: false,
        error: 'This machine no longer exists in your account.',
      };
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'Could not revoke this machine.',
    };
  }
}
