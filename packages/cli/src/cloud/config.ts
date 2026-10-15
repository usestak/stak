import { CloudNotConfiguredError } from '@stack/cloud-client';
import { resolveAliasedEnv, sameUrlValue } from '@stack/shared';

const DEV_FALLBACK = 'http://localhost:3000';
// The canonical, always-reachable production Cloud origin. An installed CLI with
// nothing configured must reach real STAK Cloud, not a developer's local server —
// requiring every ordinary end user to set an env var just to make `stak login`
// work is backwards for a published package (release-gate finding, 2026-10-15).
const PRODUCTION_FALLBACK = 'https://www.memstk.com';

/** True when `STAK_ENV`/`STACK_ENV` (or `NODE_ENV`, for the common Node convention)
 *  explicitly asks for local/dev behavior — the ONLY way localhost is reached now. */
const isExplicitlyLocal = (env: NodeJS.ProcessEnv): boolean => {
  const stakEnv = resolveAliasedEnv({
    env,
    preferred: 'STAK_ENV',
    legacy: 'STACK_ENV',
  });
  return (
    stakEnv === 'development' ||
    stakEnv === 'local' ||
    env.NODE_ENV === 'development'
  );
};

/**
 * Resolve the STAK Cloud API base URL for cloud commands. Local commands never
 * call this, so they keep working without any cloud configuration.
 *
 * UNCONFIGURED INSTALLED CLI = PRODUCTION: with nothing set, this resolves to
 * real STAK Cloud (`PRODUCTION_FALLBACK`) — localhost is reached only when
 * `STAK_ENV`/`STACK_ENV` is explicitly `development`/`local`, or `NODE_ENV` is
 * explicitly `development`. An absent/unset environment never implies dev.
 *
 * Phase R3: `STAK_API_URL` is preferred and `STACK_API_URL` is the legacy alias.
 * Setting both of a pair to conflicting values is a configuration error (see
 * `resolveAliasedEnv`).
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
  const candidate =
    options.override ??
    apiUrl ??
    options.storedApiUrl ??
    (isExplicitlyLocal(options.env) ? DEV_FALLBACK : PRODUCTION_FALLBACK);
  if (!candidate) throw new CloudNotConfiguredError();
  return candidate;
};

/**
 * Resolve the STAK web APP base URL (where `stak open` points the browser) — distinct from
 * the API URL. `STAK_APP_URL` is preferred, `STACK_APP_URL` is the legacy alias (Phase R3).
 *
 * Same rule as {@link resolveCloudBaseUrl}: an unconfigured installed CLI opens real STAK
 * Cloud, not localhost — localhost requires explicitly requesting local/dev behavior.
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
  const candidate =
    options.override ??
    appUrl ??
    (isExplicitlyLocal(options.env) ? DEV_FALLBACK : PRODUCTION_FALLBACK);
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
