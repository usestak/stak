import { cookies } from 'next/headers';

/**
 * Cross-route "last viewed machine" preference (launch UX fix). This is a UI
 * convenience only, never authorization — every page/data-loader that reads it
 * still resolves the actual viewing machine via `resolveViewingMachineId`
 * against the authenticated user's OWN `active` machine list, so a stale,
 * revoked, or cross-account value here is always safely ignored rather than
 * trusted. See `machine-context.ts`'s `resolveViewingMachineId`.
 */
export const ACTIVE_MACHINE_COOKIE = 'stak_active_machine';

/** Server-component-safe read — cookies() may be called freely during render. */
export const readActiveMachinePreference = async (): Promise<
  string | undefined
> => {
  const store = await cookies();
  return store.get(ACTIVE_MACHINE_COOKIE)?.value;
};
