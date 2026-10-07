import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SkillTreeEntry } from '@stack/shared';

import { spawnGit } from './git-reference.js';
import {
  buildReviewArtifactFiles,
  materializeExactRevision,
  DEFAULT_REVIEW_BOUNDS,
} from './skill-check.js';

const file = (relativePath: string, content: string): SkillTreeEntry => ({
  relativePath,
  type: 'file',
  content: Buffer.from(content),
});

const symlink = (relativePath: string, target: string): SkillTreeEntry => ({
  relativePath,
  type: 'symlink',
  target,
});

describe('buildReviewArtifactFiles', () => {
  it('classifies an added text file with afterText only', () => {
    const result = buildReviewArtifactFiles(
      [],
      [file('new.md', 'hello')],
      DEFAULT_REVIEW_BOUNDS,
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files).toEqual([
      {
        relativePath: 'new.md',
        kind: 'added',
        binary: false,
        after: { byteSize: 5, hash: expect.stringMatching(/^sha256:/) },
        afterText: 'hello',
      },
    ]);
  });
  it('classifies a removed text file with beforeText only', () => {
    const result = buildReviewArtifactFiles(
      [file('old.md', 'bye')],
      [],
      DEFAULT_REVIEW_BOUNDS,
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files[0]).toMatchObject({ kind: 'removed', beforeText: 'bye' });
    expect(result.files[0]?.afterText).toBeUndefined();
  });
  it('classifies a modified text file with both before and after', () => {
    const result = buildReviewArtifactFiles(
      [file('SKILL.md', 'old body')],
      [file('SKILL.md', 'new body')],
      DEFAULT_REVIEW_BOUNDS,
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files[0]).toMatchObject({
      kind: 'modified',
      beforeText: 'old body',
      afterText: 'new body',
    });
  });
  it('classifies a binary file change with no text content, only size+hash', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const result = buildReviewArtifactFiles(
      [{ relativePath: 'a.png', type: 'file', content: png }],
      [{ relativePath: 'a.png', type: 'file', content: Buffer.concat([png, Buffer.from([1])]) }],
      DEFAULT_REVIEW_BOUNDS,
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files[0]?.binary).toBe(true);
    expect(result.files[0]?.beforeText).toBeUndefined();
    expect(result.files[0]?.afterText).toBeUndefined();
    expect(result.files[0]?.before?.byteSize).toBe(png.length);
  });
  it('returns unchanged files omitted entirely', () => {
    const same = file('x.md', 'same');
    const result = buildReviewArtifactFiles([same], [same], DEFAULT_REVIEW_BOUNDS);
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files).toHaveLength(0);
  });
  it('exceeds-bounds when total bytes exceed the cap', () => {
    const huge = 'x'.repeat(DEFAULT_REVIEW_BOUNDS.maxTotalBytes + 1);
    const result = buildReviewArtifactFiles([], [file('big.md', huge)], DEFAULT_REVIEW_BOUNDS);
    expect(result.status).toBe('exceeds-bounds');
  });
  it('exceeds-bounds when file count exceeds the cap', () => {
    const many = Array.from({ length: DEFAULT_REVIEW_BOUNDS.maxFiles + 1 }, (_, i) =>
      file(`f${i}.md`, 'x'),
    );
    const result = buildReviewArtifactFiles([], many, DEFAULT_REVIEW_BOUNDS);
    expect(result.status).toBe('exceeds-bounds');
  });
  it('exceeds-bounds when one file exceeds the per-file cap, even if total is small', () => {
    const big = 'x'.repeat(DEFAULT_REVIEW_BOUNDS.maxSingleFileBytes + 1);
    const result = buildReviewArtifactFiles(
      [],
      [file('one-big.md', big)],
      { ...DEFAULT_REVIEW_BOUNDS, maxTotalBytes: DEFAULT_REVIEW_BOUNDS.maxSingleFileBytes + 1024 },
    );
    expect(result.status).toBe('exceeds-bounds');
  });

  it('classifies a symlink target change as binary with before/after size+hash, no text', () => {
    const result = buildReviewArtifactFiles(
      [symlink('link', './old-target')],
      [symlink('link', './new-target')],
      DEFAULT_REVIEW_BOUNDS,
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files).toHaveLength(1);
    const record = result.files[0];
    expect(record).toMatchObject({ relativePath: 'link', kind: 'modified', binary: true });
    expect(record?.beforeText).toBeUndefined();
    expect(record?.afterText).toBeUndefined();
    const oldTargetBytes = Buffer.from('./old-target', 'utf8');
    const newTargetBytes = Buffer.from('./new-target', 'utf8');
    expect(record?.before).toEqual({
      byteSize: oldTargetBytes.length,
      hash: `sha256:${createHash('sha256').update(oldTargetBytes).digest('hex')}`,
    });
    expect(record?.after).toEqual({
      byteSize: newTargetBytes.length,
      hash: `sha256:${createHash('sha256').update(newTargetBytes).digest('hex')}`,
    });
  });

  it('classifies an added symlink as binary with after only', () => {
    const result = buildReviewArtifactFiles(
      [],
      [symlink('new-link', './target')],
      DEFAULT_REVIEW_BOUNDS,
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files[0]).toMatchObject({ kind: 'added', binary: true });
    expect(result.files[0]?.before).toBeUndefined();
    expect(result.files[0]?.after?.byteSize).toBe(Buffer.from('./target', 'utf8').length);
  });

  it('classifies a removed symlink as binary with before only', () => {
    const result = buildReviewArtifactFiles(
      [symlink('old-link', './target')],
      [],
      DEFAULT_REVIEW_BOUNDS,
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files[0]).toMatchObject({ kind: 'removed', binary: true });
    expect(result.files[0]?.after).toBeUndefined();
    expect(result.files[0]?.before?.byteSize).toBe(Buffer.from('./target', 'utf8').length);
  });

  it('classifies a file-to-symlink type change at the same path as binary', () => {
    const result = buildReviewArtifactFiles(
      [file('x', 'some text content')],
      [symlink('x', './elsewhere')],
      DEFAULT_REVIEW_BOUNDS,
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files[0]).toMatchObject({ kind: 'modified', binary: true });
    expect(result.files[0]?.beforeText).toBeUndefined();
    expect(result.files[0]?.afterText).toBeUndefined();
  });

  it('counts a symlink target string\'s bytes toward the per-file bound', () => {
    const hugeTarget = 'x'.repeat(DEFAULT_REVIEW_BOUNDS.maxSingleFileBytes + 1);
    const result = buildReviewArtifactFiles(
      [],
      [symlink('huge-link', hugeTarget)],
      DEFAULT_REVIEW_BOUNDS,
    );
    expect(result.status).toBe('exceeds-bounds');
  });
});

describe('materializeExactRevision (real git fixture, local only)', () => {
  let repoDir: string;
  let workRoot: string;

  const run = async (cwd: string, args: string[]) => {
    const result = await spawnGit(args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    return result;
  };

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), 'stak-skillcheck-repo-'));
    workRoot = await mkdtemp(path.join(os.tmpdir(), 'stak-skillcheck-work-'));
    await run(repoDir, ['init', '-q']);
    await run(repoDir, ['config', 'user.email', 'test@example.com']);
    await run(repoDir, ['config', 'user.name', 'Test']);
    await mkdir(path.join(repoDir, 'my-skill'), { recursive: true });
    await writeFile(path.join(repoDir, 'my-skill', 'SKILL.md'), '# v1\n');
    await run(repoDir, ['add', '.']);
    await run(repoDir, ['commit', '-q', '-m', 'v1']);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(workRoot, { recursive: true, force: true });
  });

  it('fetches the exact revision’s Skill subtree, never the moving HEAD', async () => {
    const first = await run(repoDir, ['rev-parse', 'HEAD']);
    const firstRevision = first.stdout.trim();
    // Advance the repo past the revision we're about to materialize.
    await writeFile(path.join(repoDir, 'my-skill', 'SKILL.md'), '# v2\n');
    await run(repoDir, ['add', '.']);
    await run(repoDir, ['commit', '-q', '-m', 'v2']);

    const entries = await materializeExactRevision({
      workRoot,
      remote: repoDir,
      revision: firstRevision,
      skillPath: 'my-skill',
    });
    const skillFile = entries.find((e) => e.relativePath === 'SKILL.md');
    expect(skillFile?.type).toBe('file');
    expect((skillFile as { content: Buffer }).content.toString()).toBe('# v1\n');
  });

  it('rejects a skill path that escapes the repository root', async () => {
    const head = (await run(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();
    await expect(
      materializeExactRevision({
        workRoot,
        remote: repoDir,
        revision: head,
        skillPath: '../../etc',
      }),
    ).rejects.toThrow();
  });

  it('rejects an absolute path injected as the skill path', async () => {
    const head = (await run(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();
    const absolute =
      process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc';
    await expect(
      materializeExactRevision({
        workRoot,
        remote: repoDir,
        revision: head,
        skillPath: absolute,
      }),
    ).rejects.toThrow();
  });

  it('cleans up its temp working directory even on failure', async () => {
    const before = (await import('node:fs/promises')).readdir;
    await expect(
      materializeExactRevision({
        workRoot,
        remote: repoDir,
        revision: 'not-a-real-revision',
        skillPath: 'my-skill',
      }),
    ).rejects.toThrow();
    const remaining = await before(workRoot);
    expect(remaining).toHaveLength(0);
  });
});
