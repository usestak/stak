import { describe, expect, it } from 'vitest';

import { feedbackRequestSchema } from './feedback.js';

describe('feedbackRequestSchema', () => {
  it('accepts a minimal valid submission', () => {
    const result = feedbackRequestSchema.safeParse({
      type: 'idea',
      message: 'It would help if `stak status` showed staged Memory too.',
    });
    expect(result.success).toBe(true);
  });

  it('accepts the full optional shape', () => {
    const result = feedbackRequestSchema.safeParse({
      type: 'bug',
      message: 'stak pull did not restore my Claude Code memory.',
      goal: 'Restoring my setup on a new laptop.',
      email: 'dev@example.com',
      pageUrl: 'https://www.memstk.com/beta',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown type', () => {
    const result = feedbackRequestSchema.safeParse({
      type: 'complaint',
      message: 'Something.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty message', () => {
    const result = feedbackRequestSchema.safeParse({ type: 'other', message: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a message over 4000 characters', () => {
    const result = feedbackRequestSchema.safeParse({
      type: 'other',
      message: 'a'.repeat(4001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid email when provided', () => {
    const result = feedbackRequestSchema.safeParse({
      type: 'other',
      message: 'Something broke.',
      email: 'not-an-email',
    });
    expect(result.success).toBe(false);
  });

  it('strips unknown fields rather than accepting arbitrary payload keys', () => {
    const result = feedbackRequestSchema.safeParse({
      type: 'idea',
      message: 'Ok.',
      localProjectPath: '/Users/me/secret-repo',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('localProjectPath');
    }
  });
});
