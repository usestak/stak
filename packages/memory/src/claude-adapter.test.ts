import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectClaudeMemory, discoverClaudeMemory } from './claude-adapter.js';
import { hashBytes } from './store.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-mem-'));
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

// A synthetic Claude home with VALID memory + EXCLUDED sibling data.
const makeClaudeHome = async (root: string) => {
  const home = path.join(root, '.claude');
  const key = 'D--work-nado';
  // VALID
  await write(path.join(home, 'CLAUDE.md'), 'global user instructions');
  await write(
    path.join(home, 'agent-memory', 'researcher', 'notes.md'),
    'agent memory',
  );
  await write(
    path.join(home, 'projects', key, 'memory', 'MEMORY.md'),
    'memory index',
  );
  await write(
    path.join(home, 'projects', key, 'memory', 'fact.md'),
    'a learned fact',
  );
  // EXCLUDED (must never be captured)
  await write(
    path.join(home, 'projects', key, 'session-abc.jsonl'),
    'TRANSCRIPT-SECRET',
  );
  await write(path.join(home, 'history.jsonl'), 'PROMPT-HISTORY');
  await write(path.join(home, '.credentials.json'), 'AUTH-TOKEN-SECRET');
  await write(path.join(home, 'settings.json'), '{"env":{"K":"ENV-SECRET"}}');
  await write(path.join(home, 'todos', 't.json'), 'TODO');
  await write(path.join(home, 'shell-snapshots', 's.sh'), 'SHELL');
  await write(path.join(home, 'statsig', 's'), 'STATS');
  await write(path.join(home, 'plugins', 'cache', 'x'), 'PLUGIN');
  return { home, key };
};

describe('detectClaudeMemory', () => {
  it('detects a Claude home', async () => {
    const { home } = await makeClaudeHome(await temp());
    expect(await detectClaudeMemory({ claudeHome: home })).toEqual({
      installed: true,
    });
  });

  it('reports missing when there is no Claude home', async () => {
    const root = await temp();
    const detection = await detectClaudeMemory({
      claudeHome: path.join(root, 'nope'),
    });
    expect(detection.installed).toBe(false);
  });
});

describe('discoverClaudeMemory', () => {
  it('discovers only allowlisted memory and classifies each item', async () => {
    const { home } = await makeClaudeHome(await temp());
    const items = await discoverClaudeMemory({ claudeHome: home });
    const kinds = items.map((item) => item.kind).sort();
    expect(kinds).toEqual([
      'agent-memory',
      'auto-memory',
      'auto-memory',
      'user-instructions',
    ]);
    expect(items.every((item) => item.sensitivity === 'private')).toBe(true);
    expect(items.every((item) => item.provider === 'claude')).toBe(true);
  });

  it('content-hashes each item with sha256 of file bytes', async () => {
    const { home } = await makeClaudeHome(await temp());
    const items = await discoverClaudeMemory({ claudeHome: home });
    const user = items.find((item) => item.kind === 'user-instructions');
    expect(user?.contentHash).toBe(
      hashBytes(Buffer.from('global user instructions')),
    );
  });

  it('never captures transcripts, history, auth, settings, or caches', async () => {
    const { home } = await makeClaudeHome(await temp());
    const items = await discoverClaudeMemory({ claudeHome: home });
    const serialized = JSON.stringify(items);
    for (const forbidden of [
      'TRANSCRIPT-SECRET',
      'PROMPT-HISTORY',
      'AUTH-TOKEN-SECRET',
      'ENV-SECRET',
      'session-abc.jsonl',
      'history.jsonl',
      '.credentials.json',
      'settings.json',
      'todos',
      'shell-snapshots',
      'statsig',
      'plugins',
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it('attaches a portable Git identity to auto-memory of a known project', async () => {
    const { home } = await makeClaudeHome(await temp());
    // The project dir whose encoded key equals the auto-memory folder name.
    const items = await discoverClaudeMemory({
      claudeHome: home,
      projects: [
        { dir: 'D:\\work\\nado', gitRemote: 'git@github.com:me/nado.git' },
      ],
    });
    const auto = items.find((item) => item.kind === 'auto-memory');
    expect(auto?.project).toEqual({
      kind: 'git',
      host: 'github.com',
      owner: 'me',
      repo: 'nado',
      canonical: 'github.com/me/nado',
    });
  });

  it('keeps an unresolved local identity when the project is unknown', async () => {
    const { home, key } = await makeClaudeHome(await temp());
    const items = await discoverClaudeMemory({ claudeHome: home });
    const auto = items.find((item) => item.kind === 'auto-memory');
    expect(auto?.project).toEqual({ kind: 'local', vendorKey: key });
  });

  it('discovers project-private instructions and project agent-memory', async () => {
    const root = await temp();
    const { home } = await makeClaudeHome(root);
    const projectDir = path.join(root, 'repo');
    await write(path.join(projectDir, 'CLAUDE.local.md'), 'private notes');
    await write(
      path.join(projectDir, '.claude', 'agent-memory', 'coder', 'log.md'),
      'coder memory',
    );
    const items = await discoverClaudeMemory({
      claudeHome: home,
      projects: [{ dir: projectDir, gitRemote: 'https://github.com/me/repo' }],
    });
    expect(
      items.some((item) => item.kind === 'project-private-instructions'),
    ).toBe(true);
    expect(
      items.some(
        (item) => item.kind === 'agent-memory' && item.scope === 'project',
      ),
    ).toBe(true);
  });

  it('never follows symlinks out of a memory root', async (context) => {
    const root = await temp();
    const { home, key } = await makeClaudeHome(root);
    const secret = path.join(root, 'outside-secret.md');
    await write(secret, 'OUTSIDE-SECRET');
    try {
      await symlink(
        secret,
        path.join(home, 'projects', key, 'memory', 'link.md'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip();
      throw error;
    }
    const items = await discoverClaudeMemory({ claudeHome: home });
    expect(JSON.stringify(items)).not.toContain('OUTSIDE-SECRET');
    // The symlink is skipped: only the two real memory files remain.
    expect(items.filter((item) => item.kind === 'auto-memory')).toHaveLength(2);
  });
});
