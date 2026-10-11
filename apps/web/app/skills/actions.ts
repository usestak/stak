'use server';

import { CloudServiceError } from '@stack/cloud-server';
import type { SkillShareStatus } from '@stack/spec';

import { getCloudService } from '../../lib/cloud-service';
import { getSessionUser } from '../../lib/session';

const notSignedIn = { ok: false as const, error: 'You must sign in first.' };

export async function approveSkillVersionAction(input: {
  skillId: string;
  reviewArtifactId: string;
}): Promise<
  { ok: true; changed: boolean } | { ok: false; error: string; stale?: boolean }
> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    const result = await getCloudService().approveSkillVersion(
      { userId: user.id, tokenId: 'web-session' },
      input,
    );
    return { ok: true, changed: result.createdNew };
  } catch (error) {
    if (
      error instanceof CloudServiceError &&
      error.code === 'remote-environment-conflict'
    )
      return {
        ok: false,
        error: error.message,
        stale: true,
      };
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'Could not approve this update.',
    };
  }
}

/** Loads the current Sharing-section state for a Skill (§5): Shareable / Already shared /
 *  Not shareable — never a generic enabled button that can fail after the click. */
export async function getSkillShareStatusAction(
  skillId: string,
): Promise<
  { ok: true; share: SkillShareStatus } | { ok: false; error: string }
> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    const result = await getCloudService().getSkillShareStatus(
      { userId: user.id, tokenId: 'web-session' },
      skillId,
    );
    return { ok: true, share: result.share };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'Could not load sharing status for this Skill.',
    };
  }
}

export async function shareSkillAction(input: {
  skillId: string;
  slug: string;
  displayName?: string;
  description?: string;
}): Promise<
  { ok: true; url: string } | { ok: false; error: string }
> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    const result = await getCloudService().shareSkill(
      { userId: user.id, tokenId: 'web-session' },
      input,
    );
    return { ok: true, url: result.url };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : 'Could not share this Skill.',
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
