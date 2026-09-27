import { describe, expect, it } from 'vitest';

import type { ProjectIdentity, RestorePlan } from '@stack/memory';

import { renderMemoryRestore } from './memory.js';

const gitId = (repo: string): ProjectIdentity => ({
  kind: 'git',
  host: 'github.com',
  owner: 'example',
  repo,
  canonical: `github.com/example/${repo}`,
});

type Item = RestorePlan['items'][number];
const item = (repo: string, index: number, status: Item['status']): Item => ({
  logicalId: `claude/auto-memory/github.com/example/${repo}/f${index}.md`,
  kind: 'auto-memory',
  scope: 'project',
  status,
  project: gitId(repo),
});

// The exact real dogfood state: 9 projects / 24 files; only Atlas (4) matches.
const dogfoodPlan = (): RestorePlan => {
  const items: Item[] = [];
  for (let f = 0; f < 4; f += 1) items.push(item('atlas', f, 'restorable'));
  const perProject = [3, 3, 3, 3, 3, 3, 1, 1]; // 8 projects, 20 files
  perProject.forEach((count, p) => {
    for (let f = 0; f < count; f += 1)
      items.push(item(`missing${p}`, f, 'project-not-found'));
  });
  return { provider: 'claude', files: items.length, projects: 9, items };
};

describe('renderMemoryRestore', () => {
  it('reports unique project counts, not one-per-file (9 projects / 24 files)', () => {
    const output = renderMemoryRestore(dogfoodPlan(), { dryRun: true });
    expect(output).toContain('Memory restore preview');
    expect(output).toContain('9 projects in backup');
    expect(output).toContain('24 memory files');
    expect(output).toContain('4 files ready to restore');
    expect(output).toContain(
      '20 files retained from 8 projects not available on this machine',
    );
    expect(output).toContain('Existing agent memory will not be overwritten.');
    expect(output).toContain('No changes were made.');
    // The original bug: never report items as projects.
    expect(output).not.toContain('24 projects');
  });

  it('omits the unavailable-projects line when every project is present', () => {
    const items = [0, 1, 2].map((f) => item('atlas', f, 'restorable'));
    const plan: RestorePlan = {
      provider: 'claude',
      files: 3,
      projects: 1,
      items,
    };
    const output = renderMemoryRestore(plan, { dryRun: true });
    expect(output).toContain('1 project in backup');
    expect(output).toContain('3 files ready to restore');
    expect(output).not.toContain('not found on this machine');
  });

  it('does not let global (non-project) memory inflate the project count', () => {
    const items: Item[] = [
      {
        logicalId: 'claude/user-instructions/global/CLAUDE.md',
        kind: 'user-instructions',
        scope: 'global',
        status: 'restorable',
      },
      item('atlas', 0, 'restorable'),
    ];
    const output = renderMemoryRestore(
      { provider: 'claude', files: 2, projects: 1, items },
      { dryRun: true },
    );
    expect(output).toContain('1 project in backup');
    expect(output).toContain('2 memory files');
  });

  it('does not let conflict/identical items distort project counts', () => {
    const items: Item[] = [
      item('atlas', 0, 'conflict'),
      item('atlas', 1, 'identical'),
      item('atlas', 2, 'restorable'),
    ];
    const output = renderMemoryRestore(
      { provider: 'claude', files: 3, projects: 1, items },
      { dryRun: true },
    );
    expect(output).toContain('1 project in backup');
    expect(output).toContain('1 file ready to restore');
    expect(output).toContain('1 file already up to date');
    expect(output).toContain('1 file would conflict and be left unchanged');
  });

  it('keeps per-item statuses in verbose output', () => {
    const output = renderMemoryRestore(dogfoodPlan(), {
      dryRun: true,
      verbose: true,
    });
    expect(output).toContain(
      'restorable  claude/auto-memory/github.com/example/atlas/f0.md',
    );
    expect(output).toContain('project-not-found  claude/auto-memory/');
  });
});
