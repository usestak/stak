import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSyncController } from './sync-controller';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSyncController', () => {
  it('refreshes once after a single broadcast signal', () => {
    const refresh = vi.fn();
    const controller = createSyncController({ refresh, coalesceMs: 150 });

    controller.onBroadcastMessage();
    expect(refresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of broadcast signals into exactly one refresh', () => {
    const refresh = vi.fn();
    const controller = createSyncController({ refresh, coalesceMs: 150 });

    controller.onBroadcastMessage();
    vi.advanceTimersByTime(50);
    controller.onBroadcastMessage();
    vi.advanceTimersByTime(50);
    controller.onBroadcastMessage();
    vi.advanceTimersByTime(150);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('debounces focus/visibility signals', () => {
    const refresh = vi.fn();
    const controller = createSyncController({
      refresh,
      focusDebounceMs: 400,
    });

    controller.onFocus();
    vi.advanceTimersByTime(200);
    controller.onVisible();
    vi.advanceTimersByTime(399);
    expect(refresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not overlap refreshes triggered within the cooldown window', () => {
    const refresh = vi.fn();
    const controller = createSyncController({
      refresh,
      coalesceMs: 10,
      cooldownMs: 300,
    });

    controller.onBroadcastMessage();
    vi.advanceTimersByTime(10);
    expect(refresh).toHaveBeenCalledTimes(1);

    // A second signal arriving while still "cooling down" schedules a refresh call, but the
    // in-flight guard means it is a no-op until the cooldown clears.
    controller.onBroadcastMessage();
    vi.advanceTimersByTime(10);
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(300);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes again for a signal arriving after the cooldown clears', () => {
    const refresh = vi.fn();
    const controller = createSyncController({
      refresh,
      coalesceMs: 10,
      cooldownMs: 300,
    });

    controller.onBroadcastMessage();
    vi.advanceTimersByTime(10);
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(300);
    controller.onBroadcastMessage();
    vi.advanceTimersByTime(10);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('dispose cancels a pending scheduled refresh', () => {
    const refresh = vi.fn();
    const controller = createSyncController({ refresh, coalesceMs: 150 });

    controller.onBroadcastMessage();
    controller.dispose();
    vi.advanceTimersByTime(1000);

    expect(refresh).not.toHaveBeenCalled();
  });
});
