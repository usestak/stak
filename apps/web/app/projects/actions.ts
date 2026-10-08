'use server';

import { CloudServiceError } from '@stack/cloud-server';

import { getCloudService } from '../../lib/cloud-service';
import { getSessionUser } from '../../lib/session';

const notSignedIn = { ok: false as const, error: 'You must sign in first.' };

export async function setProjectLifecycleAction(input: {
  projectId: string;
  lifecycle: 'active' | 'archived';
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    await getCloudService().setProjectLifecycle(
      { userId: user.id, tokenId: 'web-session' },
      input.projectId,
      input.lifecycle,
    );
    return { ok: true };
  } catch (error) {
    if (
      error instanceof CloudServiceError &&
      error.code === 'project-not-found'
    )
      return {
        ok: false,
        error: 'This Project no longer exists in your account.',
      };
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : `Could not ${input.lifecycle === 'archived' ? 'archive' : 'unarchive'} this Project.`,
    };
  }
}
