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
  /** Per-tab id. Lets a listener recognize and ignore its own tab's emission — the
   *  BroadcastChannel spec only excludes the exact sending object instance, not every
   *  object of the same channel name in the same document, so without this a tab's own
   *  mutation handler (which already calls router.refresh() directly) would also receive
   *  its own broadcast and refresh a second time. */
  source: string;
};

/**
 * Stable for the lifetime of this module instance, which in a browser is the lifetime of
 * one tab's page load (each tab gets its own JS module registry). Computed once, lazily,
 * so importing this module in a non-browser test environment without `crypto.randomUUID`
 * still works.
 */
let tabId: string | null = null;
function getTabId(): string {
  if (tabId) return tabId;
  tabId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
  return tabId;
}

export function isOwnTabSource(source: string | undefined): boolean {
  return source !== undefined && source === getTabId();
}

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
 * router.refresh()) — this only notifies OTHER tabs. `isOwnTabSource` is what keeps the
 * initiating tab's own listener from reacting to this same message a second time.
 */
export function emitSync(domains: SyncDomain[]): void {
  if (domains.length === 0) return;
  const channel = openChannel();
  if (!channel) return;
  try {
    const message: SyncMessage = {
      domains,
      at: Date.now(),
      source: getTabId(),
    };
    channel.postMessage(message);
  } catch {
    // Non-fatal: worst case, another tab falls back to its focus/visibility refresh.
  } finally {
    channel.close();
  }
}
