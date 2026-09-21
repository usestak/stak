import { StackCloudError } from '@stack/cloud-client';

// Cloud errors whose message is already user-facing and actionable (auth,
// configuration, and synchronization conflicts). These are shown verbatim.
const ACTIONABLE_CLOUD_CODES = new Set([
  'not-authenticated',
  'authentication-expired',
  'cloud-unauthorized',
  'cloud-not-configured',
  'remote-environment-conflict',
  'local-environment-conflict',
  'remote-environment-not-found',
  'public-stack-not-found',
  'public-stack-conflict',
  'publication-not-eligible',
]);

/**
 * Turn a thrown error into a user-first CLI message. Generic Cloud failures
 * (HTTP/status noise) become a calm, actionable message; the raw details are
 * only shown with `--verbose`. Actionable Cloud errors and local errors keep
 * their already-clear messages.
 */
export const formatCliError = (
  error: Error,
  options: { verbose?: boolean } = {},
): string => {
  if (
    error instanceof StackCloudError &&
    !ACTIONABLE_CLOUD_CODES.has(error.code)
  ) {
    const message =
      'Stack Cloud could not complete the request.\n\nTry again. If the problem continues, run the command again with --verbose.';
    return options.verbose
      ? `${message}\n\nDetails: ${error.message}`
      : message;
  }
  return error.message;
};
