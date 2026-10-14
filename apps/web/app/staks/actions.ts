'use server';

import { CloudServiceError } from '@stack/cloud-server';
import type {
  CreateUserStackRequest,
  GetUserStackPublicationStatusResponse,
  PublishPublicStackVersionResponse,
  PublishUserStackRequest,
  UpdateUserStackRequest,
  UserStackDetail,
} from '@stack/spec';

import { getCloudService } from '../../lib/cloud-service';
import { getSessionUser } from '../../lib/session';

const notSignedIn = { ok: false as const, error: 'You must sign in first.' };

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

/** The approved Skills available to compose into a named Stack — the SAME Skills (and ids)
 *  `main` reads from, since a named Stack can only be built out of already-approved Skills
 *  (P10B §11: "a reusable saved composition of approved Skills"). */
export async function listApprovedSkillsForPickerAction(): Promise<
  | { ok: true; skills: { skillId: string; name: string; paused: boolean }[] }
  | { ok: false; error: string }
> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    const result = await getCloudService().getSkillsReadModel({
      userId: user.id,
      tokenId: 'web-session',
    });
    return {
      ok: true,
      skills: [...result.skills]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({ skillId: s.skillId, name: s.name, paused: s.paused })),
    };
  } catch (error) {
    return {
      ok: false,
      error: messageOf(error, 'Could not load your approved Skills.'),
    };
  }
}

export async function createUserStackAction(
  input: CreateUserStackRequest,
): Promise<{ ok: true; stackId: string } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    const result = await getCloudService().createUserStack(
      { userId: user.id, tokenId: 'web-session' },
      input,
    );
    return { ok: true, stackId: result.stackId };
  } catch (error) {
    return {
      ok: false,
      error: messageOf(error, 'Could not create this STAK.'),
    };
  }
}

export async function getUserStackDetailAction(
  stackId: string,
): Promise<
  { ok: true; detail: UserStackDetail } | { ok: false; error: string }
> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    const detail = await getCloudService().getUserStack(
      { userId: user.id, tokenId: 'web-session' },
      stackId,
    );
    return { ok: true, detail };
  } catch (error) {
    return {
      ok: false,
      error: messageOf(error, 'Could not load this STAK.'),
    };
  }
}

/** Saving an edit ALWAYS commits a brand-new immutable version server-side (never an in-place
 *  mutation) and NEVER touches `main` — see user-stack-service.ts `updateUserStack`. */
export async function updateUserStackAction(
  input: UpdateUserStackRequest,
): Promise<
  | { ok: true; versionNumber: number | null }
  | { ok: false; error: string; stale?: boolean }
> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    const result = await getCloudService().updateUserStack(
      { userId: user.id, tokenId: 'web-session' },
      input,
    );
    return { ok: true, versionNumber: result.version?.versionNumber ?? null };
  } catch (error) {
    if (
      error instanceof CloudServiceError &&
      (error.code === 'user-stack-conflict' ||
        error.code === 'user-stack-name-conflict')
    )
      return {
        ok: false,
        error: error.message,
        stale: error.code === 'user-stack-conflict',
      };
    return {
      ok: false,
      error: messageOf(error, 'Could not save this STAK.'),
    };
  }
}

/** Truthful publication lifecycle, resolved server-side on every call (spec P10 correction
 *  §13) — never cached in component state, so a reload always reflects reality. */
export async function getUserStackPublicationStatusAction(
  stackId: string,
): Promise<
  | { ok: true; status: GetUserStackPublicationStatusResponse['publication'] }
  | { ok: false; error: string }
> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    const result = await getCloudService().getUserStackPublicationStatus(
      { userId: user.id, tokenId: 'web-session' },
      stackId,
    );
    return { ok: true, status: result.publication };
  } catch (error) {
    return {
      ok: false,
      error: messageOf(error, 'Could not load publication status.'),
    };
  }
}

/** Publish a named Stack publicly (P10B §15) — reuses the existing public-Stack pipeline.
 *  Fails closed with a clear message when any Skill in the Stack can't be published; never
 *  publishes a partial composition. */
export async function publishUserStackAction(
  input: PublishUserStackRequest,
): Promise<
  | { ok: true; result: PublishPublicStackVersionResponse }
  | { ok: false; error: string }
> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    const result = await getCloudService().publishUserStack(
      { userId: user.id, tokenId: 'web-session' },
      input,
    );
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: messageOf(error, 'Could not publish this STAK.'),
    };
  }
}

/** Reversible: stops the public share only — the private Stack, its versions, and `main`
 *  are untouched; publishing again later reactivates the same public link (spec P10 final
 *  lifecycle pass §8). */
export async function unpublishUserStackAction(
  stackId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    await getCloudService().unpublishUserStack(
      { userId: user.id, tokenId: 'web-session' },
      stackId,
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: messageOf(error, 'Could not stop publishing this STAK.'),
    };
  }
}
