'use server';

import { getCloudService } from '@/lib/cloud-service';
import {
  addPasskeyMethod,
  fetchRecoverySession,
  latestKeyCheck,
  listPasskeyWrappers,
  submitRecoveryEnvelope,
  type FetchSessionResult,
} from '@/lib/recovery-actions';
import { getSessionUser } from '@/lib/session';

const notSignedIn = { ok: false as const, error: 'You must sign in first.' };

export async function fetchSessionAction(
  sessionId: string,
): Promise<FetchSessionResult | { ok: false; reason: 'not-signed-in' }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, reason: 'not-signed-in' };
  return fetchRecoverySession(getCloudService(), { id: user.id }, sessionId);
}

export async function submitEnvelopeAction(
  sessionId: string,
  envelope: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  const result = await submitRecoveryEnvelope(
    getCloudService(),
    { id: user.id },
    sessionId,
    envelope,
  );
  return result.ok ? { ok: true } : { ok: false, error: result.reason };
}

export async function listPasskeyWrappersAction(): Promise<
  | { ok: true; wrappers: Awaited<ReturnType<typeof listPasskeyWrappers>> }
  | { ok: false; error: string }
> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'You must sign in first.' };
  return {
    ok: true,
    wrappers: await listPasskeyWrappers(getCloudService(), { id: user.id }),
  };
}

/** Final review I7: see `latestKeyCheck`. */
export async function latestKeyCheckAction(): Promise<
  | { ok: true; check: Awaited<ReturnType<typeof latestKeyCheck>> }
  | { ok: false; error: string }
> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'You must sign in first.' };
  return {
    ok: true,
    check: await latestKeyCheck(getCloudService(), { id: user.id }),
  };
}

export async function addPasskeyMethodAction(input: {
  label: string;
  publicIdentifier: string;
  mmkWrapper: unknown;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    await addPasskeyMethod(getCloudService(), { id: user.id }, input);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not save passkey.',
    };
  }
}
