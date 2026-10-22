import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { encodeClaudeProjectKey } from '../project-identity.js';
import {
  claudeCanonicalPathOf,
  claudeNativeTargetOf,
  scanClaudeProject,
  writeClaudeProject,
} from './claude-project-adapter.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stak-canonical-claude-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))),
);

const write = async (file: string, body: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
};

describe('scanClaudeProject', () => {
  it('maps auto-memory, project agent-memory, and CLAUDE.local.md to canonical paths', async () => {
    const root = await temp();
    const claudeHome = path.join(root, '.claude');
    const projectDir = path.join(root, 'proj');
    const key = 'D--proj'; // simplified encoding for this fixture
    await write(path.join(claudeHome, 'projects', key, 'memory', 'MEMORY.md'), 'hello');
    await write(
      path.join(projectDir, '.claude', 'agent-memory', 'reviewer', 'notes.md'),
      'agent notes',
    );
    await write(path.join(projectDir, 'CLAUDE.local.md'), 'private');

    const result = await scanClaudeProject(
      { projectId: 'prj_x', dir: projectDir },
      {
        claudeHome,
        projects: [{ dir: projectDir }],
        resolveProjectId: () => 'prj_x',
      },
    );

    expect(result.sourceConflicts).toEqual([]);
    const byPath = new Map(result.docs.map((d) => [d.canonicalPath, d]));
    expect(byPath.get('notes/MEMORY.md')?.bytes.toString()).toBe('hello');
    expect(byPath.get('agents/reviewer/notes.md')?.bytes.toString()).toBe('agent notes');
    expect(byPath.get('instructions/private.md')?.bytes.toString()).toBe('private');
  });

  it('omits items whose resolved project id does not match', async () => {
    const root = await temp();
    const claudeHome = path.join(root, '.claude');
    const projectDir = path.join(root, 'proj');
    await write(path.join(projectDir, 'CLAUDE.local.md'), 'private');

    const result = await scanClaudeProject(
      { projectId: 'prj_x', dir: projectDir },
      {
        claudeHome,
        projects: [{ dir: projectDir }],
        resolveProjectId: () => 'prj_other',
      },
    );
    expect(result.docs).toEqual([]);
  });

  it('reports a source conflict when two matched Claude folders disagree, and omits that path', async () => {
    const root = await temp();
    const claudeHome = path.join(root, '.claude');
    const projectDir = path.join(root, 'proj');
    // Two auto-memory folders both matched (same gitRemote) with different content
    // at the same relative file — simulate via gitRemoteOf resolving both to the
    // same identity while `projects` only lists the current one; the second is a
    // leftover folder discovered independently by discoverClaudeMemory's own
    // reconstruction path. For this unit test we instead directly construct the
    // ambiguity by giving two DIFFERENT vendor keys both an identical gitRemote so
    // discoverClaudeMemory resolves them to the SAME git identity.
    await write(path.join(claudeHome, 'projects', 'key-old', 'memory', 'a.md'), 'old');
    await write(path.join(claudeHome, 'projects', 'key-new', 'memory', 'a.md'), 'new');

    const result = await scanClaudeProject(
      { projectId: 'prj_x', dir: projectDir },
      {
        claudeHome,
        projects: [{ dir: projectDir, gitRemote: 'git@github.com:acme/widgets.git' }],
        gitRemoteOf: async () => 'git@github.com:acme/widgets.git',
        isDirectory: async () => true,
        resolveProjectId: () => 'prj_x',
      },
    );
    expect(result.sourceConflicts).toEqual([{ canonicalPath: 'notes/a.md' }]);
    expect(result.docs.find((d) => d.canonicalPath === 'notes/a.md')).toBeUndefined();
  });
});

describe('path mapping', () => {
  it('maps canonical paths to Claude native targets and back', () => {
    const project = { projectId: 'prj_x', dir: path.join('C:', 'work', 'proj') };
    expect(claudeNativeTargetOf(project, 'instructions/private.md')).toBe(
      path.join(project.dir, 'CLAUDE.local.md'),
    );
    expect(claudeNativeTargetOf(project, 'agents/reviewer/notes.md')).toBe(
      path.join(project.dir, '.claude', 'agent-memory', 'reviewer', 'notes.md'),
    );
  });

  it('rejects an out-of-namespace canonical path', () => {
    expect(() => claudeNativeTargetOf({ projectId: 'prj_x', dir: '/x' }, 'other/a.md')).toThrow();
  });
});

describe('writeClaudeProject', () => {
  it('writes and deletes native files for the bound project only', async () => {
    const root = await temp();
    // NOTE: the plan brief's literal test for this case omitted a `claudeHome`
    // argument even though its ops include a `notes/` write. `writeClaudeProject`
    // defaults `claudeHome` to the REAL `os.homedir()/.claude` when omitted, so
    // without this fix the test would silently write (and never clean up) a real
    // file under the developer's actual ~/.claude directory. We pass a sandboxed
    // `claudeHome` under the temp root instead, which is what the brief's own prose
    // ("none of the Step 1 tests [write a notes/ path]") evidently assumed.
    const claudeHome = path.join(root, '.claude');
    const projectDir = path.join(root, 'proj');
    await writeClaudeProject(
      { projectId: 'prj_x', dir: projectDir },
      [
        { kind: 'write', canonicalPath: 'instructions/private.md', bytes: Buffer.from('p') },
        { kind: 'write', canonicalPath: 'notes/a.md', bytes: Buffer.from('n') },
      ],
      claudeHome,
    );
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path.join(projectDir, 'CLAUDE.local.md'), 'utf8')).toBe('p');
    expect(
      await readFile(
        path.join(
          claudeHome,
          'projects',
          encodeClaudeProjectKey(path.resolve(projectDir)),
          'memory',
          'a.md',
        ),
        'utf8',
      ),
    ).toBe('n');

    await writeClaudeProject(
      { projectId: 'prj_x', dir: projectDir },
      [{ kind: 'delete', canonicalPath: 'instructions/private.md' }],
      claudeHome,
    );
    await expect(readFile(path.join(projectDir, 'CLAUDE.local.md'), 'utf8')).rejects.toThrow();
  });
});
