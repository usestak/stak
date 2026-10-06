import { describe, expect, it } from 'vitest';

import {
  SEARCH_THRESHOLD,
  filterOptions,
  nextActiveIndex,
} from './machine-selector-logic';

describe('nextActiveIndex (machine selector keyboard)', () => {
  it('ArrowDown advances and wraps; ArrowUp retreats and wraps', () => {
    expect(nextActiveIndex(0, 'ArrowDown', 3)).toBe(1);
    expect(nextActiveIndex(2, 'ArrowDown', 3)).toBe(0);
    expect(nextActiveIndex(0, 'ArrowUp', 3)).toBe(2);
    expect(nextActiveIndex(-1, 'ArrowDown', 3)).toBe(0);
  });
  it('Home/End jump to ends; empty list stays -1; unknown key is a no-op', () => {
    expect(nextActiveIndex(2, 'Home', 3)).toBe(0);
    expect(nextActiveIndex(0, 'End', 3)).toBe(2);
    expect(nextActiveIndex(0, 'ArrowDown', 0)).toBe(-1);
    expect(nextActiveIndex(1, 'x', 3)).toBe(1);
  });
});

describe('filterOptions (machine selector search, P4 §3/§9)', () => {
  const options = [
    { machineId: 'a', name: 'Atlas', secondary: 'macOS · arm64 · Up to date' },
    {
      machineId: 'b',
      name: 'Studio',
      secondary: 'Linux · x64 · Updates waiting',
    },
    {
      machineId: 'c',
      name: 'Unnamed machine',
      secondary: 'ID 15ca62b6 · No check-in yet',
    },
  ];

  it('an empty query returns all options unchanged', () => {
    expect(filterOptions(options, '')).toEqual(options);
    expect(filterOptions(options, '   ')).toEqual(options);
  });

  it('matches case-insensitively on the primary name', () => {
    expect(filterOptions(options, 'atlas').map((o) => o.machineId)).toEqual([
      'a',
    ]);
    expect(filterOptions(options, 'STUDIO').map((o) => o.machineId)).toEqual([
      'b',
    ]);
  });

  it('also matches the secondary line (platform/arch/status/short id)', () => {
    expect(filterOptions(options, 'linux').map((o) => o.machineId)).toEqual([
      'b',
    ]);
    expect(filterOptions(options, '15ca62b6').map((o) => o.machineId)).toEqual([
      'c',
    ]);
  });

  it('no match returns an empty array (never falls back to the full list)', () => {
    expect(filterOptions(options, 'nonexistent')).toEqual([]);
  });
});

describe('SEARCH_THRESHOLD', () => {
  it('is a small positive number used to decide when the search field appears', () => {
    expect(SEARCH_THRESHOLD).toBeGreaterThan(0);
    expect(SEARCH_THRESHOLD).toBeLessThanOrEqual(10);
  });
});
