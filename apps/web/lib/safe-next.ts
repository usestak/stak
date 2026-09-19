/**
 * Constrain a post-auth `next` target to a same-origin relative path, defeating
 * open-redirect attempts (`//evil.com`, `https://evil.com`, `/\evil.com`).
 */
export const safeNext = (raw: string | null): string => {
  if (
    raw &&
    raw.startsWith('/') &&
    !raw.startsWith('//') &&
    !raw.startsWith('/\\')
  )
    return raw;
  return '/cli';
};
