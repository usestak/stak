'use server';

import { CloudServiceError } from '@stack/cloud-server';

import { getCloudService } from '../../lib/cloud-service';
import { getSessionUser } from '../../lib/session';

const notSignedIn = { ok: false as const, error: 'You must sign in first.' };

export async function approveSkillVersionAction(input: {
  skillId: string;
  candidateContentHash: string;
  candidateRevision: string;
}): Promise<{ ok: true; changed: boolean } | { ok: false; error: string; stale?: boolean }> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    const result = await getCloudService().approveSkillVersion(
      { userId: user.id, tokenId: 'web-session' },
      input,
    );
    return { ok: true, changed: result.createdNew };
  } catch (error) {
    if (error instanceof CloudServiceError && error.code === 'skill-not-found')
      return { ok: false, error: 'This Skill or candidate is no longer current.', stale: true };
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not approve this update.',
    };
  }
}

export async function setSkillPausedAction(input: {
  skillId: string;
  paused: boolean;
}): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    const result = await getCloudService().setSkillPaused(
      { userId: user.id, tokenId: 'web-session' },
      input,
    );
    return { ok: true, changed: result.changed };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : `Could not ${input.paused ? 'pause' : 'resume'} this Skill.`,
    };
  }
}
