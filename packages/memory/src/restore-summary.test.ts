import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ManifestItem, ProjectIdentity } from './domain.js';
import { planMemoryRestore } from './restore.js';
import { countProjects, type RestoreItemResult } from './restore.js';
import { writeMemoryManifest } from './store.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-memsum-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const gitId = (repo: string): ProjectIdentity => ({
  kind: 'git',
  host: 'github.com',
  owner: 'example',
  repo,
  canonical: `github.com/example/${repo}`,
});

const projectItem = (
  repo: string,
  index: number,
  status: RestoreItemResult['status'] = 'restorable',
): RestoreItemResult => ({
  logicalId: `claude/auto-memory/github.com/example/${repo}/f${index}.md`,
  kind: 'auto-memory',
  scope: 'project',
  status,
  project: gitId(repo),
});

describe('countProjects', () => {
  it('counts unique project identities, not memory files (24 files, 9 projects)', () => {
    // 9 projects with per-project file counts summing to 24 (each project ≥ 1).
    const perProject = [3, 3, 3, 3, 3, 3, 2, 2, 2];
    const items: RestoreItemResult[] = [];
    perProject.forEach((count, p) => {
      for (let f = 0; f < count; f += 1) items.push(projectItem(`proj${p}`, f));
    });
    expect(items.length).toBe(24);
    expect(countProjects(items)).toBe(9);
  });

  it('treats multiple files from one project as a single project', () => {
    const items = [0, 1, 2, 3].map((f) => projectItem('atlas', f));
    expect(countProjects(items)).toBe(1);
  });

  it('does not count non-project (global) memory as a project', () => {
    const globalItem: RestoreItemResult = {
      logicalId: 'claude/user-instructions/global/CLAUDE.md',
      kind: 'user-instructions',
      scope: 'global',
      status: 'restorable',
    };
    const items = [
      globalItem,
      projectItem('atlas', 0),
      projectItem('atlas', 1),
    ];
    expect(countProjects(items)).toBe(1);
  });

  it('is not distorted by conflict/identical statuses', () => {
    const items = [
      projectItem('atlas', 0, 'conflict'),
      projectItem('atlas', 1, 'identical'),
      projectItem('atlas', 2, 'restorable'),
    ];
    expect(countProjects(items)).toBe(1);
  });
});

describe('planMemoryRestore aggregation', () => {
  const manifestItem = (repo: string, index: number): ManifestItem => ({
    provider: 'claude',
    kind: 'auto-memory',
    scope: 'project',
    logicalId: `claude/auto-memory/github.com/example/${repo}/f${index}.md`,
    project: gitId(repo),
    contentHash: `sha256:${'a'.repeat(64)}`,
    restoreTarget: {
      base: 'claude-project-memory',
      relativePath: `f${index}.md`,
    },
    capturedAt: '2026-09-24T12:00:00.000Z',
    sensitivity: 'private',
  });

  it('reports unique matched/unmatched project counts and file counts', async () => {
    const stackHome = await temp();
    // 3 projects, 6 files: atlas (2) present; beta (2) + gamma (2) absent.
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-09-24T12:00:00.000Z',
        items: [
          manifestItem('atlas', 0),
          manifestItem('atlas', 1),
          manifestItem('beta', 0),
          manifestItem('beta', 1),
          manifestItem('gamma', 0),
          manifestItem('gamma', 1),
        ],
      },
    });
    const plan = await planMemoryRestore({
      stackHome,
      claudeHome: path.join(await temp(), '.claude'),
      projects: [
        {
          dir: 'C:\\Users\\NT\\Desktop\\atlas',
          gitRemote: 'git@github.com:example/atlas.git',
        },
      ],
    });
    expect(plan.files).toBe(6);
    expect(plan.projects).toBe(3); // unique projects in backup, not 6
    const restorable = plan.items.filter((i) => i.status === 'restorable');
    const notFound = plan.items.filter((i) => i.status === 'project-not-found');
    expect(restorable).toHaveLength(2);
    expect(notFound).toHaveLength(4);
    expect(countProjects(notFound)).toBe(2); // beta + gamma
  });
});
