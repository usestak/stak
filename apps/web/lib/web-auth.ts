import { cache } from 'react';

/**
 * The web calls the P3 service as the signed-in session user (identity never from input).
 * `cache()`-wrapped (keyed on the primitive `userId`, so this is safe unlike caching an
 * object-keyed call directly) so every loader that calls `webAuth(user.id)` within one
 * request gets back the SAME object reference — required for `cache()`-wrapped CloudService
 * reads (e.g. `getOverview`) to actually dedupe when called with "the same" auth from
 * multiple places in the same request, since React's `cache()` keys non-primitive arguments
 * by reference, not deep equality.
 */
export const webAuth = cache((userId: string) => ({
  userId,
  tokenId: 'web-session',
}));
