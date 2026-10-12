import { describe, expect, it } from 'vitest';

import { assessSkillShareEligibility } from './skill-share.js';
import type { PortableRestorationStrategy } from './cloud.js';

const reference = (remote: string): PortableRestorationStrategy => ({
  strategy: 'reference',
  reference: {
    remote,
    revision: 'a'.repeat(40),
    path: 'skills/x',
    expectedContentHash: `sha256:${'a'.repeat(64)}`,
  },
});

const snapshot = (
  reason:
    | 'local'
    | 'unknown-source'
    | 'ambiguous-source'
    | 'modified-source'
    | 'non-portable-source',
): PortableRestorationStrategy => ({
  strategy: 'snapshot',
  contentHash: `sha256:${'a'.repeat(64)}`,
  reason,
});

describe('assessSkillShareEligibility (spec P10A §4)', () => {
  it('a safe HTTPS Git reference is eligible', () => {
    expect(
      assessSkillShareEligibility(reference('https://github.com/a/b.git')),
    ).toEqual({ eligible: true });
  });

  it('an exact-pinned reference (no tracked ref) is still eligible — immutable revision is the ideal case', () => {
    const pinned = reference('https://github.com/a/b.git');
    expect(
      pinned.strategy === 'reference' ? pinned.reference.ref : undefined,
    ).toBeUndefined();
    expect(assessSkillShareEligibility(pinned)).toEqual({ eligible: true });
  });

  it('Local-origin Skills fail closed with the plain-language copy', () => {
    const result = assessSkillShareEligibility(snapshot('local'));
    expect(result.eligible).toBe(false);
    if (!result.eligible)
      expect(result.reason).toContain("can't publish a safe public reference");
  });

  for (const reason of [
    'unknown-source',
    'ambiguous-source',
    'modified-source',
    'non-portable-source',
  ] as const) {
    it(`${reason} Skills fail closed`, () => {
      expect(assessSkillShareEligibility(snapshot(reason)).eligible).toBe(
        false,
      );
    });
  }

  it('a credential-bearing remote fails closed and never echoes the credential', () => {
    const result = assessSkillShareEligibility(
      reference('https://user:supersecret@github.com/a/b.git'),
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).not.toContain('supersecret');
  });

  it('a local filesystem remote fails closed', () => {
    expect(
      assessSkillShareEligibility(reference('/home/user/repo')).eligible,
    ).toBe(false);
    expect(
      assessSkillShareEligibility(reference('file:///home/user/repo')).eligible,
    ).toBe(false);
  });

  it('a loopback remote fails closed', () => {
    expect(
      assessSkillShareEligibility(reference('https://localhost/a/b.git'))
        .eligible,
    ).toBe(false);
  });
});
