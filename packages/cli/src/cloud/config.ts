import { CloudNotConfiguredError } from '@stack/cloud-client';

const DEV_FALLBACK = 'http://localhost:3000';

/**
 * Resolve the STAK Cloud API base URL for cloud commands. Local commands never
 * call this, so they keep working without any cloud configuration. In production
 * an unset endpoint fails clearly; in development it falls back to localhost.
 */
export const resolveCloudBaseUrl = (options: {
  env: NodeJS.ProcessEnv;
  storedApiUrl?: string;
  override?: string;
}): string => {
  const candidate =
    options.override ??
    options.env.STACK_API_URL ??
    options.storedApiUrl ??
    (options.env.STACK_ENV === 'production' ||
    options.env.NODE_ENV === 'production'
      ? undefined
      : DEV_FALLBACK);
  if (!candidate) throw new CloudNotConfiguredError();
  return candidate;
};
