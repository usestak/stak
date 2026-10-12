import { describe, expect, it } from 'vitest';

import {
  canonicalizeUserStackName,
  createUserStackRequestSchema,
  userStackNameSchema,
} from './user-stack.js';

describe('userStackNameSchema — canonical named-Stack identity (spec P10 correction §1/§5)', () => {
  it('trims and lowercases', () => {
    expect(userStackNameSchema.parse(' Frontend ')).toBe('frontend');
  });

  it('accepts the existing public-Stack slug character class', () => {
    expect(userStackNameSchema.parse('frontend-mobile_v2')).toBe(
      'frontend-mobile_v2',
    );
  });

  it('rejects "main" after normalization, in every case variant', () => {
    for (const candidate of ['main', 'MAIN', 'Main', ' main ']) {
      expect(userStackNameSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('rejects a leading @ (would be unreachable via `stak use`)', () => {
    expect(userStackNameSchema.safeParse('@frontend').success).toBe(false);
  });

  it('rejects invalid characters', () => {
    expect(userStackNameSchema.safeParse('front end!').success).toBe(false);
    expect(userStackNameSchema.safeParse('').success).toBe(false);
  });

  it('canonicalizeUserStackName is the exact same trim+lowercase step the schema applies', () => {
    expect(canonicalizeUserStackName(' Frontend ')).toBe('frontend');
  });

  it('makes case/whitespace variants collide to the same identity', () => {
    const a = userStackNameSchema.parse('Frontend');
    const b = userStackNameSchema.parse(' frontend ');
    expect(a).toBe(b);
  });

  it('createUserStackRequestSchema canonicalizes name at the request boundary', () => {
    const parsed = createUserStackRequestSchema.parse({
      name: ' Frontend ',
      skillIds: ['skill_abc12345'],
    });
    expect(parsed.name).toBe('frontend');
  });
});
