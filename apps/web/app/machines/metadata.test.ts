import { describe, test, expect } from 'vitest';

import { metadata } from './page';

describe('machines route metadata', () => {
  test('is noindex, nofollow (signed-in, account-specific route)', () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });
});
