import { CloudNotConfiguredError } from '@stack/cloud-client';
import { resolveAliasedEnv, sameUrlValue } from '@stack/shared';

const DEV_FALLBACK = 'http://localhost:3000';

/**
 * Resolve the STAK Cloud API base URL for cloud commands. Local commands never
 * call this, so they keep working without any cloud configuration. In production
 * an unset endpoint fails clearly; in development it falls back to localhost.
 *
 * Phase R3: `STAK_API_URL` is preferred and `STACK_API_URL` is the legacy alias;
 * likewise `STAK_ENV` / `STACK_ENV`. Setting both of a pair to conflicting values is
 * a configuration error (see `resolveAliasedEnv`).
 */
export const resolveCloudBaseUrl = (options: {
  env: NodeJS.ProcessEnv;
  storedApiUrl?: string;
  override?: string;
}): string => {
  const apiUrl = resolveAliasedEnv({
    env: options.env,
    preferred: 'STAK_API_URL',
    legacy: 'STACK_API_URL',
    equivalent: sameUrlValue,
  });
  const stakEnv = resolveAliasedEnv({
    env: options.env,
    preferred: 'STAK_ENV',
    legacy: 'STACK_ENV',
  });
  const candidate =
    options.override ??
    apiUrl ??
    options.storedApiUrl ??
    (stakEnv === 'production' || options.env.NODE_ENV === 'production'
      ? undefined
      : DEV_FALLBACK);
  if (!candidate) throw new CloudNotConfiguredError();
  return candidate;
};
