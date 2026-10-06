import { describe, expect, it } from 'vitest';

import { nextActiveIndex } from './machine-selector-logic';

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
