/**
 * Pure (no DOM, no React) scheduling core behind `useStakSync`. Kept separate so the
 * coalescing/debounce/overlap-guard behavior is unit-testable without rendering a component
 * or touching BroadcastChannel/jsdom visibility APIs.
 */
export type SyncControllerOptions = {
  refresh: () => void;
  /** Delay before acting on a burst of BroadcastChannel messages — coalesces them into one refresh. */
  coalesceMs?: number;
  /** Delay before acting on a focus/visibility signal — avoids refreshing on a rapid tab-flick. */
  focusDebounceMs?: number;
  /** Minimum time between actual refresh() calls, so near-simultaneous triggers can't overlap. */
  cooldownMs?: number;
  /**
   * Ignore focus/visibility signals while the page's data is younger than this. Focus is
   * only a fallback for missed Realtime/broadcast signals, and a full server re-render on
   * every alt-tab back makes navigation feel sluggish. Broadcasts are never throttled.
   */
  focusMinIntervalMs?: number;
  now?: () => number;
};

export type SyncController = {
  onBroadcastMessage: () => void;
  onVisible: () => void;
  onFocus: () => void;
  /** The page just rendered fresh server data (e.g. a navigation completed). */
  markFresh: () => void;
  dispose: () => void;
};

const DEFAULT_COALESCE_MS = 150;
const DEFAULT_FOCUS_DEBOUNCE_MS = 400;
const DEFAULT_COOLDOWN_MS = 300;

export function createSyncController(
  options: SyncControllerOptions,
): SyncController {
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  const focusDebounceMs = options.focusDebounceMs ?? DEFAULT_FOCUS_DEBOUNCE_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const focusMinIntervalMs = options.focusMinIntervalMs ?? 0;
  const now = options.now ?? Date.now;

  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let cooling: ReturnType<typeof setTimeout> | null = null;
  let refreshing = false;
  let freshAt = Number.NEGATIVE_INFINITY;

  const runRefresh = () => {
    if (refreshing) return;
    refreshing = true;
    freshAt = now();
    try {
      options.refresh();
    } finally {
      cooling = setTimeout(() => {
        refreshing = false;
        cooling = null;
      }, cooldownMs);
    }
  };

  const schedule = (delay: number) => {
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      scheduled = null;
      runRefresh();
    }, delay);
  };

  const scheduleFocus = () => {
    if (now() - freshAt < focusMinIntervalMs) return;
    schedule(focusDebounceMs);
  };

  return {
    onBroadcastMessage: () => schedule(coalesceMs),
    onVisible: () => scheduleFocus(),
    onFocus: () => scheduleFocus(),
    markFresh: () => {
      freshAt = now();
    },
    dispose: () => {
      if (scheduled) clearTimeout(scheduled);
      if (cooling) clearTimeout(cooling);
      scheduled = null;
      cooling = null;
    },
  };
}
