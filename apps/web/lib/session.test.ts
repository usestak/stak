import { describe, expect, it } from 'vitest';

import { displayNameOf, type WebUser } from './session.js';

describe('displayNameOf', () => {
  it('prefers the display name', () => {
    const user: WebUser = {
      id: 'u1',
      githubUsername: 'stephentony100',
      displayName: 'Temiloluwa',
    };
    expect(displayNameOf(user)).toBe('Temiloluwa');
  });

  it('falls back to the GitHub handle', () => {
    expect(displayNameOf({ id: 'u1', githubUsername: 'stephentony100' })).toBe(
      'stephentony100',
    );
  });

  it('falls back to a neutral label with no profile', () => {
    expect(displayNameOf({ id: 'u1' })).toBe('Signed in');
  });
});
