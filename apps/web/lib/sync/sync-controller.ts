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
};

export type SyncController = {
  onBroadcastMessage: () => void;
  onVisible: () => void;
  onFocus: () => void;
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

  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let cooling: ReturnType<typeof setTimeout> | null = null;
  let refreshing = false;

  const runRefresh = () => {
    if (refreshing) return;
    refreshing = true;
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

  return {
    onBroadcastMessage: () => schedule(coalesceMs),
    onVisible: () => schedule(focusDebounceMs),
    onFocus: () => schedule(focusDebounceMs),
    dispose: () => {
      if (scheduled) clearTimeout(scheduled);
      if (cooling) clearTimeout(cooling);
      scheduled = null;
      cooling = null;
    },
  };
}
