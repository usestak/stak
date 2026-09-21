import { describe, expect, it } from 'vitest';

import { relativeTime, skillCount } from './format.js';

describe('skillCount', () => {
  it('pluralizes correctly', () => {
    expect(skillCount(0)).toBe('0 skills');
    expect(skillCount(1)).toBe('1 skill');
    expect(skillCount(31)).toBe('31 skills');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-09-21T12:00:00.000Z').getTime();
  it('reports very recent times as "just now"', () => {
    expect(relativeTime('2026-09-21T11:59:40.000Z', now)).toBe('just now');
  });
  it('reports minutes, hours, and days', () => {
    expect(relativeTime('2026-09-21T11:00:00.000Z', now)).toBe('1 hour ago');
    expect(relativeTime('2026-09-21T09:00:00.000Z', now)).toBe('3 hours ago');
    expect(relativeTime('2026-09-19T12:00:00.000Z', now)).toBe('2 days ago');
  });
  it('handles invalid input gracefully', () => {
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});
