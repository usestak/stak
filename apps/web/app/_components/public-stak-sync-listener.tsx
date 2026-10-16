'use client';

import { usePublicStackSync } from '@/lib/sync/public-stak-sync';

export function PublicStakSyncListener({ stackId }: { stackId: string }) {
  usePublicStackSync(stackId);
  return null;
}
