import { describe, expect, it, vi } from 'vitest';

import { rangeStart } from './admin-date-range';

describe('rangeStart', () => {
  it('returns null for "all" (no lower bound)', () => {
    expect(rangeStart('all')).toBeNull();
  });

  it('returns a Date 24 hours before now for "24h"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    expect(rangeStart('24h')).toEqual(new Date('2026-10-19T12:00:00.000Z'));
    vi.useRealTimers();
  });

  it('returns a Date 7 days before now for "7d"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    expect(rangeStart('7d')).toEqual(new Date('2026-10-13T12:00:00.000Z'));
    vi.useRealTimers();
  });

  it('returns a Date 30 days before now for "30d"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    expect(rangeStart('30d')).toEqual(new Date('2026-09-20T12:00:00.000Z'));
    vi.useRealTimers();
  });
});
