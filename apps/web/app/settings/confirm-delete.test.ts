import { describe, expect, it } from 'vitest';

import { isValidDeleteConfirmation } from './confirm-delete.js';

describe('isValidDeleteConfirmation', () => {
  it('requires the exact phrase, case-sensitive', () => {
    expect(isValidDeleteConfirmation('DELETE CLOUD MEMORY')).toBe(true);
    expect(isValidDeleteConfirmation('delete cloud memory')).toBe(false);
    expect(isValidDeleteConfirmation('DELETE')).toBe(false);
    expect(isValidDeleteConfirmation('')).toBe(false);
    expect(isValidDeleteConfirmation(undefined)).toBe(false);
  });
});
