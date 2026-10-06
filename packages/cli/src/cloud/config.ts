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

/**
 * Resolve the STAK web APP base URL (where `stak open` points the browser) — distinct from
 * the API URL. `STAK_APP_URL` is preferred, `STACK_APP_URL` is the legacy alias (Phase R3).
 * In development it falls back to localhost; in production an unset URL fails clearly.
 */
export const resolveCloudAppUrl = (options: {
  env: NodeJS.ProcessEnv;
  override?: string;
}): string => {
  const appUrl = resolveAliasedEnv({
    env: options.env,
    preferred: 'STAK_APP_URL',
    legacy: 'STACK_APP_URL',
    equivalent: sameUrlValue,
  });
  const stakEnv = resolveAliasedEnv({
    env: options.env,
    preferred: 'STAK_ENV',
    legacy: 'STACK_ENV',
  });
  const candidate =
    options.override ??
    appUrl ??
    (stakEnv === 'production' || options.env.NODE_ENV === 'production'
      ? undefined
      : DEV_FALLBACK);
  if (!candidate) throw new CloudNotConfiguredError();
  return candidate;
};

/**
 * Build the signed-in Overview URL for a machine context. The machine id is the ONLY query
 * parameter; it is URL-encoded. Never place tokens, secrets, or Memory in the URL. Any path or
 * query already on the app URL is preserved (the machine param is set, not blindly appended).
 */
export const buildOpenUrl = (appUrl: string, machineId: string): string => {
  const url = new URL(appUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/overview`;
  url.searchParams.set('machine', machineId);
  return url.toString();
};
