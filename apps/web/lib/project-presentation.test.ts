import { describe, expect, it } from 'vitest';

import {
  cliProjectSelector,
  lifecycleLabel,
  presenceLabel,
} from './project-presentation.js';

describe('cliProjectSelector', () => {
  it('uses the display name when it is unique', () => {
    const all = [
      { projectId: 'prj_abc123', name: 'stak' },
      { projectId: 'prj_def456', name: 'other-repo' },
    ];
    expect(cliProjectSelector('prj_abc123', 'stak', all)).toBe('stak');
  });

  it('falls back to the stable projectId when the name collides', () => {
    const all = [
      { projectId: 'prj_abc123', name: 'api' },
      { projectId: 'prj_def456', name: 'api' },
    ];
    expect(cliProjectSelector('prj_abc123', 'api', all)).toBe('prj_abc123');
  });

  it('falls back to the stable projectId when there is no name', () => {
    const all = [{ projectId: 'prj_abc123', name: undefined }];
    expect(cliProjectSelector('prj_abc123', undefined as any, all)).toBe(
      'prj_abc123',
    );
  });
});

describe('presenceLabel', () => {
  it('reports On this machine when present', () => {
    expect(presenceLabel(['m1', 'm2'], 'm1')).toBe('On this machine');
  });
  it('reports Not on this machine when absent', () => {
    expect(presenceLabel(['m2'], 'm1')).toBe('Not on this machine');
  });
  it('reports Not on this machine for an empty presence list', () => {
    expect(presenceLabel([], 'm1')).toBe('Not on this machine');
  });
});

describe('lifecycleLabel', () => {
  it('capitalizes active', () => {
    expect(lifecycleLabel('active')).toBe('Active');
  });
  it('capitalizes archived', () => {
    expect(lifecycleLabel('archived')).toBe('Archived');
  });
});
