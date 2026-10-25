/**
 * Recovery-ceremony server logic (pure; unit-testable with the in-memory service).
 *
 * The thin 'use server' wrappers in app/memory/actions.ts derive the user from the
 * authenticated Supabase session (never a request field) and call these with
 * getCloudService(). All Memory access is scoped to the caller's user id by the
 * backend, so another user's session/methods are invisible (returned as not-found).
 * The server only ever relays opaque session/envelope JSON — never the MMK.
 */
import type { CloudService } from '@stack/cloud-server';

export type CeremonyUser = { id: string };

export type MemoryCeremonyPort = Pick<
  CloudService,
  | 'memoryGetSession'
  | 'memorySubmitEnvelope'
  | 'memoryListRecoveryMethods'
  | 'memoryAddRecoveryMethod'
  | 'memoryGetLatest'
>;

/**
 * Final review I7: the latest Protected generation's backup id and wrapped DEK
 * (metadata only, never the payload), so the browser can confirm a
 * passkey-unwrapped Memory key really opens this account's Memory before
 * sending it to the CLI. Null when the latest generation isn't Protected.
 */
export const latestKeyCheck = async (
  service: MemoryCeremonyPort,
  user: CeremonyUser,
): Promise<{
  backupId: string;
  wrappedDek: { nonceB64: string; ciphertextB64: string; tagB64: string };
} | null> => {
  const { generation } = await service.memoryGetLatest({ userId: user.id });
  if (!generation || generation.privacyMode !== 'protected' || !generation.wrappedDek) return null;
  const { nonceB64, ciphertextB64, tagB64 } = generation.wrappedDek as {
    nonceB64: string;
    ciphertextB64: string;
    tagB64: string;
  };
  return { backupId: generation.backupId, wrappedDek: { nonceB64, ciphertextB64, tagB64 } };
};

export type FetchSessionResult =
  | {
      ok: true;
      sessionId: string;
      direction: 'recovery' | 'enrollment';
      expiresAt: string;
      /** Opaque bridge session JSON (the CLI's public key etc.) for the browser. */
      session: unknown;
    }
  | { ok: false; reason: 'not-found' | 'expired' | 'consumed' };

export const fetchRecoverySession = async (
  service: MemoryCeremonyPort,
  user: CeremonyUser,
  sessionId: string,
  now: () => Date = () => new Date(),
): Promise<FetchSessionResult> => {
  const { session } = await service.memoryGetSession(
    { userId: user.id },
    sessionId,
  );
  if (!session) return { ok: false, reason: 'not-found' };
  if (session.consumedAt) return { ok: false, reason: 'consumed' };
  if (now().getTime() > new Date(session.expiresAt).getTime())
    return { ok: false, reason: 'expired' };
  return {
    ok: true,
    sessionId: session.sessionId,
    direction: session.direction,
    expiresAt: session.expiresAt,
    session: session.session,
  };
};

export const submitRecoveryEnvelope = async (
  service: MemoryCeremonyPort,
  user: CeremonyUser,
  sessionId: string,
  envelope: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  // Re-check ownership + liveness before writing.
  const current = await fetchRecoverySession(service, user, sessionId);
  if (!current.ok) return { ok: false, reason: current.reason };
  await service.memorySubmitEnvelope({ userId: user.id }, sessionId, envelope);
  return { ok: true };
};

export const listPasskeyWrappers = async (
  service: MemoryCeremonyPort,
  user: CeremonyUser,
): Promise<
  { methodId: string; publicIdentifier: string | null; mmkWrapper: unknown }[]
> => {
  const { methods } = await service.memoryListRecoveryMethods({
    userId: user.id,
  });
  return methods
    .filter((method) => method.type === 'passkey')
    .map((method) => ({
      methodId: method.methodId,
      publicIdentifier: method.publicIdentifier,
      mmkWrapper: method.mmkWrapper,
    }));
};

export const addPasskeyMethod = async (
  service: MemoryCeremonyPort,
  user: CeremonyUser,
  input: { label: string; publicIdentifier: string; mmkWrapper: unknown },
): Promise<{ methodId: string }> => {
  const { method } = await service.memoryAddRecoveryMethod(
    { userId: user.id },
    {
      type: 'passkey',
      label: input.label,
      publicIdentifier: input.publicIdentifier,
      mmkWrapper: input.mmkWrapper,
      cryptoVersion: 'stack-mem-cipher-v1',
    },
  );
  return { methodId: method.methodId };
};
