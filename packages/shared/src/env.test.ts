import { describe, expect, it } from 'vitest';

import { resolveAliasedEnv, sameNumericValue, sameUrlValue } from './env.js';

const P = 'STAK_X';
const L = 'STACK_X';

describe('resolveAliasedEnv (R3)', () => {
  it('returns undefined when neither is set', () => {
    expect(resolveAliasedEnv({ env: {}, preferred: P, legacy: L })).toBe(
      undefined,
    );
  });

  it('new only → new', () => {
    expect(
      resolveAliasedEnv({ env: { STAK_X: 'a' }, preferred: P, legacy: L }),
    ).toBe('a');
  });

  it('legacy only → legacy', () => {
    expect(
      resolveAliasedEnv({ env: { STACK_X: 'b' }, preferred: P, legacy: L }),
    ).toBe('b');
  });

  it('both equivalent → accepted (new value returned)', () => {
    expect(
      resolveAliasedEnv({
        env: { STAK_X: 'same', STACK_X: 'same' },
        preferred: P,
        legacy: L,
      }),
    ).toBe('same');
  });

  it('both conflicting → error naming both variables', () => {
    expect(() =>
      resolveAliasedEnv({
        env: { STAK_X: 'a', STACK_X: 'b' },
        preferred: P,
        legacy: L,
      }),
    ).toThrow(/STAK_X.*STACK_X/s);
  });

  it('secret conflict error never echoes either secret value', () => {
    const secretA = 'super-secret-AAAA';
    const secretB = 'super-secret-BBBB';
    try {
      resolveAliasedEnv({
        env: { STAK_X: secretA, STACK_X: secretB },
        preferred: P,
        legacy: L,
      });
      throw new Error('expected a conflict error');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(secretA);
      expect(message).not.toContain(secretB);
      expect(message).toContain('STAK_X');
    }
  });

  it('URL equivalence ignores a trailing slash', () => {
    expect(
      resolveAliasedEnv({
        env: { STAK_X: 'https://x.test', STACK_X: 'https://x.test/' },
        preferred: P,
        legacy: L,
        equivalent: sameUrlValue,
      }),
    ).toBe('https://x.test');
    expect(() =>
      resolveAliasedEnv({
        env: { STAK_X: 'https://x.test', STACK_X: 'https://y.test' },
        preferred: P,
        legacy: L,
        equivalent: sameUrlValue,
      }),
    ).toThrow();
  });

  it('numeric equivalence compares parsed values', () => {
    expect(
      resolveAliasedEnv({
        env: { STAK_X: '1000', STACK_X: '1000.0' },
        preferred: P,
        legacy: L,
        equivalent: sameNumericValue,
      }),
    ).toBe('1000');
    expect(() =>
      resolveAliasedEnv({
        env: { STAK_X: '1000', STACK_X: '2000' },
        preferred: P,
        legacy: L,
        equivalent: sameNumericValue,
      }),
    ).toThrow();
  });
});
