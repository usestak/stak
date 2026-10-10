import type {
  CloudService,
  PendingCliAuthSessionView,
} from '@stack/cloud-server';

/** The read method the CLI approval screen consumes; injectable so it's unit-testable. */
export type CliAuthQueryService = Pick<
  CloudService,
  'getPendingCliAuthSession'
>;

/**
 * Read-only peek at the CLI auth session for a given code — the real-only shape
 * `CloudService.getPendingCliAuthSession` returns. Used to render the "Authorize the
 * STAK CLI" screen truthfully BEFORE the user clicks Approve: a real pending session
 * (with or without a label), an expired session, or an already-consumed/approved
 * session. No platform/arch field exists on the session — none is ever added here.
 */
export async function loadPendingCliAuthSession(
  service: CliAuthQueryService,
  userCode: string,
): Promise<PendingCliAuthSessionView | null> {
  return service.getPendingCliAuthSession(userCode);
}
