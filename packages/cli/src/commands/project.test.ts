import { describe, expect, it } from 'vitest';

import type { ProjectListRow } from '../memory/project-ops.js';
import { identityLabel, renderProjectList } from './project.js';

const baseRow = (overrides: Partial<ProjectListRow>): ProjectListRow => ({
  projectId: 'prj_abc123',
  identity: { kind: 'local' },
  lifecycle: 'active',
  binding: null,
  files: 0,
  availability: 'unavailable',
  conflict: false,
  recoveryReference: null,
  discoveredName: null,
  ...overrides,
});

describe('identityLabel (project-naming UX)', () => {
  it('shows the canonical Git identity for a Git-backed project', () => {
    const row = baseRow({
      identity: { kind: 'git', canonical: 'github.com/acme/atlas' },
    });
    expect(identityLabel(row)).toBe('github.com/acme/atlas');
  });

  it('shows the bound directory basename for a mapped Local project, never the full path', () => {
    const row = baseRow({ binding: 'C:/Users/NT/Desktop/swft' });
    expect(identityLabel(row)).toBe('swft');
    expect(identityLabel(row)).not.toContain('Users');
  });

  it('falls back to the generic label for an unmapped Local project', () => {
    const row = baseRow({ binding: null });
    expect(identityLabel(row)).toBe('local project');
  });

  it('falls back to the generic label when the binding has no safe basename', () => {
    const row = baseRow({ binding: 'C:/' });
    expect(identityLabel(row)).toBe('local project');
  });

  it('shows the discovery-time name hint for an unmapped Local project, never the generic label', () => {
    const row = baseRow({ binding: null, discoveredName: 'nexus' });
    expect(identityLabel(row)).toBe('nexus');
  });

  it('prefers the discovery-time name hint over the binding basename when both are present', () => {
    const row = baseRow({
      binding: 'C:/Users/NT/Desktop/old-folder-name',
      discoveredName: 'nexus',
    });
    expect(identityLabel(row)).toBe('nexus');
  });
});

describe('renderProjectList (project-naming UX)', () => {
  it('surfaces the recognizable basename as the identity label (the full local path is shown separately, on the "mapped to" line, for the user\'s own machine only)', () => {
    const output = renderProjectList([
      baseRow({ binding: 'C:/Users/NT/Desktop/swft' }),
    ]);
    expect(output).toContain('swft');
    expect(output).toContain('mapped to C:/Users/NT/Desktop/swft');
  });

  it('shows the generic label for an unmapped Local project, not a raw id as content', () => {
    const output = renderProjectList([baseRow({})]);
    expect(output).toContain('local project');
  });
});
