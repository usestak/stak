'use server';

import { cookies } from 'next/headers';

import { ACTIVE_MACHINE_COOKIE } from '../../lib/machine-preference';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Called when the user explicitly picks a machine (sidebar selector or the
 *  full-page chooser). Not authorization — see `machine-preference.ts`. */
export async function setActiveMachinePreference(
  machineId: string,
): Promise<void> {
  const store = await cookies();
  store.set(ACTIVE_MACHINE_COOKIE, machineId, {
    httpOnly: true,
    sameSite: 'lax',
    // Secure cookies are dropped over plain HTTP — only require it once we're
    // actually served over HTTPS (production), so local dev keeps working.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  });
}
