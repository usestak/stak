'use client';

/**
 * Cross-tab invalidation signal for authenticated Memory STAK pages. Every page is a
 * force-dynamic server component with no caching layer (see audit), so "invalidation" here
 * just means "tell other same-origin tabs to call router.refresh() soon" — the server
 * remains the single source of truth; no entity content ever crosses this channel.
 */
export type SyncDomain =
  | 'overview'
  | 'sidebar'
  | 'machines'
  | 'skills'
  | 'memory'
  | 'projects'
  | 'staks'
  | 'publication';

export const SYNC_CHANNEL_NAME = 'stak-sync';

export type SyncMessage = {
  domains: SyncDomain[];
  at: number;
};

function openChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(SYNC_CHANNEL_NAME);
  } catch {
    // Some browsers/contexts (e.g. certain private-browsing modes) can throw on
    // construction. Cross-tab sync is a nice-to-have, never a hard dependency.
    return null;
  }
}

/**
 * Call after a mutation's own view has already updated (local state + the existing
 * router.refresh()) — this only notifies OTHER tabs. The initiating tab never needs to
 * react to its own broadcast, and the BroadcastChannel spec already excludes the sender
 * from receiving its own message, so there is no self-triggered refresh loop to guard
 * against here.
 */
export function emitSync(domains: SyncDomain[]): void {
  if (domains.length === 0) return;
  const channel = openChannel();
  if (!channel) return;
  try {
    const message: SyncMessage = { domains, at: Date.now() };
    channel.postMessage(message);
  } catch {
    // Non-fatal: worst case, another tab falls back to its focus/visibility refresh.
  } finally {
    channel.close();
  }
}
