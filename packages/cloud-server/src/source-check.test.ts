import { describe, expect, it, vi } from 'vitest';

import {
  createCachedSourceChecker,
  type SkillSourceChecker,
} from './source-check.js';

const ref = (revision: string) =>
  ({
    strategy: 'reference' as const,
    reference: {
      remote: 'https://github.com/acme/skills.git',
      revision,
      path: 'skills/x',
      expectedContentHash: `sha256:${'a'.repeat(64)}`,
      ref: 'refs/heads/main',
    },
  }) satisfies Parameters<SkillSourceChecker>[0]['restoration'];

describe('createCachedSourceChecker (P3 §5)', () => {
  it('serves a cached result within the TTL, then re-resolves after it expires', async () => {
    let clock = 0;
    const inner = vi.fn(async () => ({ status: 'same' as const }));
    const checker = createCachedSourceChecker({
      inner,
      ttlMs: 1000,
      now: () => new Date(clock),
    });
    const input = { skillId: 'skill_aaaaaaaa', restoration: ref('r1') };
    await checker(input);
    await checker(input);
    expect(inner).toHaveBeenCalledTimes(1); // second call is a cache hit
    clock = 1500; // past TTL
    await checker(input);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('keys by exact source identity, so a changed approved revision re-resolves', async () => {
    const inner = vi.fn(async () => ({ status: 'same' as const }));
    const checker = createCachedSourceChecker({
      inner,
      ttlMs: 10_000,
      now: () => new Date(0),
    });
    await checker({ skillId: 'skill_aaaaaaaa', restoration: ref('r1') });
    await checker({ skillId: 'skill_aaaaaaaa', restoration: ref('r2') });
    expect(inner).toHaveBeenCalledTimes(2); // different revision ⇒ different key
  });

  it('fails closed on an inner error (uncheckable) and does not cache it', async () => {
    let fail = true;
    const inner = vi.fn(async () => {
      if (fail) throw new Error('network');
      return { status: 'same' as const };
    });
    const checker = createCachedSourceChecker({
      inner,
      ttlMs: 10_000,
      now: () => new Date(0),
    });
    const input = { skillId: 'skill_aaaaaaaa', restoration: ref('r1') };
    expect(await checker(input)).toEqual({ status: 'uncheckable' });
    fail = false;
    // The error was not cached as a definitive answer, so the next call re-resolves.
    expect(await checker(input)).toEqual({ status: 'same' });
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
