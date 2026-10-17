import { describe, expect, it } from 'vitest';

import { resolveSyncedProjectName } from './repository.js';

describe('resolveSyncedProjectName (Cloud project-name sync, recovery-path safety)', () => {
  it('an incoming name always wins (fresher discovery)', () => {
    expect(resolveSyncedProjectName('nexus', 'old-name')).toBe('nexus');
    expect(resolveSyncedProjectName('nexus', null)).toBe('nexus');
  });

  it('preserves the existing Cloud name when the incoming sync carries no name', () => {
    expect(resolveSyncedProjectName(undefined, 'nexus')).toBe('nexus');
  });

  it('stays null when neither the incoming sync nor the existing row has a name', () => {
    expect(resolveSyncedProjectName(undefined, null)).toBeNull();
  });
});
