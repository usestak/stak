/**
 * Pure redirect-target decision for the OAuth callback. Isolated from the route
 * handler so the failure path (silently redirecting on a failed code exchange,
 * which left an unauthenticated user looking signed in) can be unit-tested.
 */
export const resolveCallbackTarget = (input: {
  code: string | null;
  next: string;
  exchangeFailed: boolean;
}): string => {
  if (!input.code) return '/auth/error?reason=missing-code';
  if (input.exchangeFailed) return '/auth/error?reason=exchange-failed';
  return input.next;
};
