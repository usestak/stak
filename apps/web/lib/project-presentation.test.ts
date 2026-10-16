import { describe, expect, it } from 'vitest';

import {
  cliProjectSelector,
  lifecycleLabel,
  presenceLabel,
  projectDisplayName,
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

describe('projectDisplayName', () => {
  it('shows the repo segment for a Git-backed project (not the full prj_ id)', () => {
    const all = [{ projectId: 'prj_abc123', name: 'github.com/usestak/stak' }];
    expect(projectDisplayName(all[0]!, all)).toBe('stak');
  });

  it('falls back to the full canonical name when two repos share a short segment', () => {
    const all = [
      { projectId: 'prj_abc123', name: 'github.com/usestak/atlas' },
      { projectId: 'prj_def456', name: 'github.com/other-org/atlas' },
    ];
    expect(projectDisplayName(all[0]!, all)).toBe('github.com/usestak/atlas');
    expect(projectDisplayName(all[1]!, all)).toBe('github.com/other-org/atlas');
  });

  it('never fabricates a name for a Local project — honest "Local project" + short id', () => {
    const all = [{ projectId: 'prj_4vm1k8z8tdq54ftc6j534xqh08' }];
    const result = projectDisplayName(all[0]!, all);
    expect(result).toBe('Local project · prj_4vm1…qh08');
    // The stable id is never replaced, only ever shown shortened alongside the label.
    expect(result).not.toContain('nexus');
  });

  it('does not let a Local project collide-check against itself', () => {
    const all = [
      { projectId: 'prj_aaa' },
      { projectId: 'prj_bbb', name: 'github.com/a/repo' },
    ];
    expect(projectDisplayName(all[0]!, all)).toBe('Local project · prj_aaa');
  });

  it('shows a Local basename directly when unique', () => {
    const all = [{ projectId: 'prj_abc123', name: 'swft' }];
    expect(projectDisplayName(all[0]!, all)).toBe('swft');
  });

  it('disambiguates two Local projects with the same basename using a stable projectId discriminator', () => {
    const all = [
      { projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaa81f', name: 'app' },
      { projectId: 'prj_bbbbbbbbbbbbbbbbbbbbbbbbbc92d', name: 'app' },
    ];
    expect(projectDisplayName(all[0]!, all)).toBe('app · A81F');
    expect(projectDisplayName(all[1]!, all)).toBe('app · C92D');
    // Identity itself is never touched by the disambiguation.
    expect(all[0]!.projectId).toBe('prj_aaaaaaaaaaaaaaaaaaaaaaaaa81f');
  });

  it('never confuses a Local basename collision with a Git canonical name collision', () => {
    const all = [
      { projectId: 'prj_local1', name: 'stak' },
      { projectId: 'prj_git1', name: 'github.com/usestak/stak' },
    ];
    expect(projectDisplayName(all[0]!, all)).toBe('stak');
    expect(projectDisplayName(all[1]!, all)).toBe('stak');
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
