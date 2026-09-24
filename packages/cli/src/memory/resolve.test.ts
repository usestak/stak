import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeMemoryAdapter } from '@stack/memory';

import { resolveMemoryProjects } from './resolve.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-memscan-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const write = async (file: string, body: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
};

// The real dogfood topology: cwd is the Stack checkout; Atlas is a sibling.
const DESKTOP = 'C:\\Users\\NT\\Desktop';
const CWD = `${DESKTOP}\\stack`;
const ATLAS_ORIGIN = 'https://github.com/example/atlas-access-flow.git';

/**
 * Build a Claude home whose auto-memory folders match the observed real machine,
 * and a fake OS environment (siblings + git origins) for the resolver.
 */
const fixture = async (siblings: string[], origins: Record<string, string>) => {
  const root = await temp();
  const claudeHome = path.join(root, '.claude');
  const projects = {
    atlas: 'c--Users-NT-Desktop-atlas-access-flow',
    stack: 'c--Users-NT-Desktop-stack',
    dyces: 'c--Users-NT-Desktop-dyces-landing', // historical, dir no longer exists
  };
  for (const key of Object.values(projects))
    await write(
      path.join(claudeHome, 'projects', key, 'memory', 'MEMORY.md'),
      'memory index',
    );
  await write(
    path.join(claudeHome, 'projects', projects.atlas, 'memory', 'fact.md'),
    'atlas fact',
  );

  const resolverDeps = {
    cwd: CWD,
    platform: 'win32' as NodeJS.Platform,
    listDirs: async (dir: string) =>
      dir === DESKTOP ? siblings : ([] as string[]),
    gitOrigin: async (dir: string) => origins[dir],
  };
  const projectList = await resolveMemoryProjects(resolverDeps);
  const adapter = createClaudeMemoryAdapter({
    stackHome: path.join(root, 'stack-home'),
    claudeHome,
    platform: 'win32',
    projects: projectList,
  });
  return { items: await adapter.discover(), projects };
};

describe('memory scan orchestration (real CLI path)', () => {
  it('resolves a sibling Atlas checkout to its canonical Git identity from the Stack cwd', async () => {
    const { items } = await fixture(['stack', 'atlas-access-flow'], {
      [`${DESKTOP}\\atlas-access-flow`]: ATLAS_ORIGIN,
    });
    const atlas = items.filter((item) =>
      item.logicalId.includes('atlas-access-flow'),
    );
    expect(atlas.length).toBeGreaterThanOrEqual(2);
    for (const item of atlas) {
      expect(item.project).toEqual({
        kind: 'git',
        host: 'github.com',
        owner: 'example',
        repo: 'atlas-access-flow',
        canonical: 'github.com/example/atlas-access-flow',
      });
      expect(item.logicalId).toContain(
        'auto-memory/github.com/example/atlas-access-flow',
      );
      expect(item.logicalId).not.toContain(
        'local:c--Users-NT-Desktop-atlas-access-flow',
      );
    }
  });

  it('keeps the Stack cwd (no origin) and a missing historical project as local', async () => {
    const { items } = await fixture(
      ['stack', 'atlas-access-flow'],
      { [`${DESKTOP}\\atlas-access-flow`]: ATLAS_ORIGIN }, // stack has no origin
    );
    const stack = items.find((item) => item.logicalId.includes('-stack/'));
    expect(stack?.project).toEqual({
      kind: 'local',
      vendorKey: 'c--Users-NT-Desktop-stack',
    });
    const dyces = items.find((item) =>
      item.logicalId.includes('dyces-landing'),
    );
    expect(dyces?.project).toEqual({
      kind: 'local',
      vendorKey: 'c--Users-NT-Desktop-dyces-landing',
    });
  });

  it('does not leak credentials from a credential-bearing origin', async () => {
    const { items } = await fixture(['stack', 'atlas-access-flow'], {
      [`${DESKTOP}\\atlas-access-flow`]:
        'https://user:ghp_supersecret@github.com/example/atlas-access-flow.git',
    });
    const serialized = JSON.stringify(items);
    expect(serialized).toContain('github.com/example/atlas-access-flow');
    expect(serialized).not.toContain('ghp_supersecret');
  });
});
