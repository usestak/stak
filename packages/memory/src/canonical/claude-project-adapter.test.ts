import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PathFenceError } from '@stack/shared';

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
    // Two auto-memory folders (vendor keys `key-old` and `key-new`) with different
    // content at the same relative file `a.md`. Neither key actually resolves to a
    // shared Git identity here (`key-old`/`key-new` don't match the drive-letter
    // vendor-key shape `reconstructProjectDir` expects, so both fall back to
    // unresolved local identities) — the `gitRemoteOf`/`isDirectory` options below
    // are unused in practice for this fixture. What actually makes both items
    // "matched" is the `resolveProjectId: () => 'prj_x'` stub below: it ignores its
    // `item` argument entirely and returns `'prj_x'` unconditionally, so
    // `scanClaudeProject`'s matched-filter accepts every discovered item regardless
    // of identity. Both land on canonical path `notes/a.md` with different content
    // hashes, which is what exercises `scanClaudeProject`'s dedup-by-hash conflict
    // detection.
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
        {
          kind: 'write',
          canonicalPath: 'agents/reviewer/notes.md',
          bytes: Buffer.from('agent notes'),
        },
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
    // Exercises the narrowed `agents/` owned root on a normal, successful write
    // (not only in the symlink-rejection tests below).
    expect(
      await readFile(
        path.join(projectDir, '.claude', 'agent-memory', 'reviewer', 'notes.md'),
        'utf8',
      ),
    ).toBe('agent notes');

    await writeClaudeProject(
      { projectId: 'prj_x', dir: projectDir },
      [{ kind: 'delete', canonicalPath: 'instructions/private.md' }],
      claudeHome,
    );
    await expect(readFile(path.join(projectDir, 'CLAUDE.local.md'), 'utf8')).rejects.toThrow();
  });

  it('refuses to write through a symlink planted at the agent directory', async (context) => {
    const { readFile } = await import('node:fs/promises');
    const root = await temp();
    const projectDir = path.join(root, 'proj');
    // A sibling directory still inside the sandboxed project.dir tree, but OUTSIDE
    // `.claude/agent-memory/` — simulates an attacker-controlled repo checkout that
    // plants `.claude/agent-memory/<agent>` as a symlink pointing elsewhere inside
    // project.dir (e.g. `.git/hooks`). Before narrowing ownedRoot to
    // `.claude/agent-memory`, assertPathWithin's realpath-based containment check
    // would still see this as "within project.dir" and allow the write.
    const escapeTarget = path.join(projectDir, 'escape-target');
    await mkdir(escapeTarget, { recursive: true });
    await mkdir(path.join(projectDir, '.claude', 'agent-memory'), { recursive: true });
    try {
      await symlink(
        escapeTarget,
        path.join(projectDir, '.claude', 'agent-memory', 'reviewer'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return context.skip();
      throw error;
    }

    await expect(
      writeClaudeProject({ projectId: 'prj_x', dir: projectDir }, [
        { kind: 'write', canonicalPath: 'agents/reviewer/notes.md', bytes: Buffer.from('pwned') },
      ]),
    ).rejects.toBeInstanceOf(PathFenceError);

    await expect(
      readFile(path.join(escapeTarget, 'notes.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it('refuses to write when .claude/agent-memory itself is a symlink', async (context) => {
    const { readFile } = await import('node:fs/promises');
    const root = await temp();
    const projectDir = path.join(root, 'proj');
    // A sibling directory still inside the sandboxed project.dir tree, but OUTSIDE
    // `.claude/` entirely — simulates an attacker-controlled repo checkout that
    // plants `.claude/agent-memory` ITSELF as a symlink (rather than just the
    // `<agent>` segment underneath it). `assertPathWithin` realpath-canonicalizes
    // the OWNED ROOT as well as the proposed target, so without
    // `assertRootHasNoSymlinkSegments` the narrowed root would silently
    // canonicalize to wherever this symlink points, and a write to
    // `agents/reviewer/notes.md` would be allowed "within" that redirected root.
    const escapeTarget = path.join(projectDir, 'escape-target');
    await mkdir(escapeTarget, { recursive: true });
    await mkdir(path.join(projectDir, '.claude'), { recursive: true });
    try {
      await symlink(escapeTarget, path.join(projectDir, '.claude', 'agent-memory'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return context.skip();
      throw error;
    }

    await expect(
      writeClaudeProject({ projectId: 'prj_x', dir: projectDir }, [
        { kind: 'write', canonicalPath: 'agents/reviewer/notes.md', bytes: Buffer.from('pwned') },
      ]),
    ).rejects.toBeInstanceOf(PathFenceError);

    await expect(
      readFile(path.join(escapeTarget, 'reviewer', 'notes.md'), 'utf8'),
    ).rejects.toThrow();
  });
});
