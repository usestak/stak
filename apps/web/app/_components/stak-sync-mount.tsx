'use client';

import { usePathname } from 'next/navigation';

import { useStakSync } from '../../lib/sync/use-stak-sync';

/** The signed-in dashboard routes that render `AppSidebar` and want live sync. */
export const isSyncedPath = (pathname: string): boolean =>
  pathname === '/memory' ||
  /^\/(overview|skills|projects|machines|staks|settings)(\/|$)/.test(pathname);

/**
 * Mounted once in the root layout, which never remounts on client navigation — so moving
 * between dashboard pages keeps one Realtime channel open instead of leaving and
 * rejoining it on every click (as happened while each page's sidebar owned it).
 */
export function StakSyncMount() {
  const pathname = usePathname() ?? '';
  useStakSync({ enabled: isSyncedPath(pathname), freshKey: pathname });
  return null;
}
