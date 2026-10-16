'use client';

import { usePublicProfileSync } from '@/lib/sync/public-stak-sync';

export function PublicProfileSyncListener({
  ownerHandle,
}: {
  ownerHandle: string;
}) {
  usePublicProfileSync(ownerHandle);
  return null;
}
