import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from './concurrency.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('mapWithConcurrency', () => {
  it('preserves input order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      for (let i = 0; i < n; i += 1) await tick();
      inFlight -= 1;
      return n * 10;
    });
    expect(result).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it('returns an empty array for no items', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it('rejects with the first error and starts no new work after it', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n);
        await tick();
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    expect(started).not.toContain(6);
  });

  it('rejects with the error thrown first in time, not the lowest index or worker', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        mapWithConcurrency([0, 1, 2], 3, async (n) => {
          // Item 2 fails first; items 0 and 1 fail later while still in flight.
          for (let i = 0; i < 3 - n; i += 1) await tick();
          throw new Error(`fail ${n}`);
        }),
      ).rejects.toThrow('fail 2');
      await tick();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('waits for in-flight work to settle before rejecting', async () => {
    let settled = 0;
    await expect(
      mapWithConcurrency([0, 1, 2], 3, async (n) => {
        if (n === 0) throw new Error('early');
        for (let i = 0; i < 3; i += 1) await tick();
        settled += 1;
        return n;
      }),
    ).rejects.toThrow('early');
    expect(settled).toBe(2);
  });

  it('treats a non-positive or non-finite limit as a valid width', async () => {
    const double = async (n: number) => n * 2;
    expect(await mapWithConcurrency([1, 2, 3], 0, double)).toEqual([2, 4, 6]);
    expect(await mapWithConcurrency([1, 2, 3], Number.NaN, double)).toEqual([
      2, 4, 6,
    ]);
    expect(await mapWithConcurrency([1, 2, 3], Infinity, double)).toEqual([
      2, 4, 6,
    ]);
  });
});
