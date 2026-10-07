import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { spawnGit } from '@stack/core';
import type { EnvironmentLock, LockedSkill, RestorationStrategy } from '@stack/spec';

import { runSkillCheck, type SkillCheckReporter } from './skill-check-runner.js';

const reference = (
  revision: string,
  options: { ref?: string; remote: string; path?: string },
): RestorationStrategy =>
  ({
    strategy: 'reference',
    reference: {
      remote: options.remote,
      revision,
      path: options.path ?? 'my-skill',
      expectedContentHash: `sha256:${'a'.repeat(64)}`,
      ...(options.ref ? { ref: options.ref } : {}),
    },
  }) as RestorationStrategy;

const snapshot = (reason: string): RestorationStrategy =>
  ({
    strategy: 'snapshot',
    snapshotId: 'snap_aaaaaaaa',
    reason,
  }) as RestorationStrategy;

const lockedSkill = (
  name: string,
  restoration: RestorationStrategy,
): LockedSkill => ({
  name,
  description: `${name} description`,
  contentHash: `sha256:${'b'.repeat(64)}`,
  observedSources: [],
  localContent: { available: true, contentHash: `sha256:${'b'.repeat(64)}` },
  restoration,
});

const makeLock = (skills: Record<string, LockedSkill>): EnvironmentLock => ({
  schemaVersion: 1,
  resolvedAt: '2026-10-07T00:00:00.000Z',
  skills,
});

/** A fake cloud-client exposing ONLY the two methods `runSkillCheck` is allowed to call — no
 *  approve/pause/resume/install, so any accidental call throws a TypeError rather than silently
 *  succeeding. */
const fakeReporter = (): SkillCheckReporter & {
  reportCalls: Array<{ skillId: string; body: Record<string, unknown> }>;
  uploadCalls: Array<{
    skillId: string;
    metadata: Record<string, unknown>;
    payloadBytes: Uint8Array;
  }>;
} => {
  const reportCalls: Array<{ skillId: string; body: Record<string, unknown> }> = [];
  const uploadCalls: Array<{
    skillId: string;
    metadata: Record<string, unknown>;
    payloadBytes: Uint8Array;
  }> = [];
  return {
    reportCalls,
    uploadCalls,
    reportSkillSourceCheck: async (skillId, body) => {
      reportCalls.push({ skillId, body: body as Record<string, unknown> });
      return { ok: true } as const;
    },
    uploadSkillReviewArtifact: async (skillId, metadata, payloadBytes) => {
      uploadCalls.push({
        skillId,
        metadata: metadata as unknown as Record<string, unknown>,
        payloadBytes,
      });
      return { reviewArtifactId: 'artifact_' + uploadCalls.length };
    },
  };
};

describe('runSkillCheck', () => {
  let repoDir: string;
  let workRoot: string;

  const run = async (cwd: string, args: string[]) => {
    const result = await spawnGit(args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.exitCode !== 0)
      throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    return result;
  };

  const commit = async (message: string) => {
    await run(repoDir, ['add', '.']);
    await run(repoDir, ['commit', '-q', '-m', message]);
    return (await run(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();
  };

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), 'stak-skillcheck-repo-'));
    workRoot = await mkdtemp(path.join(os.tmpdir(), 'stak-skillcheck-work-'));
    await run(repoDir, ['init', '-q']);
    await run(repoDir, ['checkout', '-q', '-b', 'main']);
    await run(repoDir, ['config', 'user.email', 'test@example.com']);
    await run(repoDir, ['config', 'user.name', 'Test']);
    await mkdir(path.join(repoDir, 'my-skill'), { recursive: true });
    await writeFile(path.join(repoDir, 'my-skill', 'SKILL.md'), '# v1\n');
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(workRoot, { recursive: true, force: true });
  });

  it('reports no-update when the tracked ref still resolves to the approved revision', async () => {
    const revision = await commit('v1');
    const lock = makeLock({
      skill_aaaaaaaa: lockedSkill(
        'My Skill',
        reference(revision, { remote: repoDir, ref: 'refs/heads/main' }),
      ),
    });
    const reporter = fakeReporter();
    const result = await runSkillCheck({ lock, workRoot, reporter });

    expect(result.checked).toEqual([
      { entryId: 'skill_aaaaaaaa', name: 'My Skill', outcome: 'no-update' },
    ]);
    expect(reporter.reportCalls).toEqual([
      {
        skillId: 'skill_aaaaaaaa',
        body: expect.objectContaining({ sourceCheckState: 'no-update' }),
      },
    ]);
    expect(reporter.uploadCalls).toHaveLength(0);
  });

  it('uploads a review artifact when the tracked ref has a newer revision', async () => {
    const approvedRevision = await commit('v1');
    await writeFile(path.join(repoDir, 'my-skill', 'SKILL.md'), '# v2\n');
    const candidateRevision = await commit('v2');

    const lock = makeLock({
      skill_bbbbbbbb: lockedSkill(
        'My Skill',
        reference(approvedRevision, { remote: repoDir, ref: 'refs/heads/main' }),
      ),
    });
    const reporter = fakeReporter();
    const result = await runSkillCheck({ lock, workRoot, reporter });

    expect(result.checked).toEqual([
      {
        entryId: 'skill_bbbbbbbb',
        name: 'My Skill',
        outcome: 'update-available',
        exceedsBounds: false,
        candidateRevision,
        reviewArtifactId: 'artifact_1',
      },
    ]);
    expect(reporter.reportCalls).toHaveLength(0);
    expect(reporter.uploadCalls).toHaveLength(1);
    const call = reporter.uploadCalls[0];
    expect(call?.skillId).toBe('skill_bbbbbbbb');
    expect(call?.metadata).toMatchObject({ candidateRevision });
    expect(call?.metadata.files).toEqual([
      expect.objectContaining({ relativePath: 'SKILL.md', kind: 'modified' }),
    ]);
    // The metadata's files must NEVER carry beforeText/afterText.
    const files = call?.metadata.files as Array<Record<string, unknown>>;
    for (const file of files) {
      expect(file.beforeText).toBeUndefined();
      expect(file.afterText).toBeUndefined();
    }
    // The text content lives only in the separately-hashed payload bytes.
    const payloadText = new TextDecoder().decode(call?.payloadBytes);
    expect(payloadText).toContain('# v1');
    expect(payloadText).toContain('# v2');
  });

  it('reports cannot-check for a Local-restoration Skill without materializing anything', async () => {
    const lock = makeLock({
      skill_cccccccc: lockedSkill('Local Skill', snapshot('local')),
    });
    const reporter = fakeReporter();
    const result = await runSkillCheck({ lock, workRoot, reporter });

    expect(result.checked).toEqual([
      {
        entryId: 'skill_cccccccc',
        name: 'Local Skill',
        outcome: 'cannot-check',
        cannotCheckReason: 'local',
      },
    ]);
    expect(reporter.reportCalls).toEqual([
      {
        skillId: 'skill_cccccccc',
        body: expect.objectContaining({
          sourceCheckState: 'cannot-check',
          cannotCheckReason: 'local',
        }),
      },
    ]);
    expect(reporter.uploadCalls).toHaveLength(0);
  });

  it('reports check-failed, with a sanitized reason, when materializing the source fails', async () => {
    // The approved revision is bogus — it was never committed to this repo — so the ref
    // resolution reports 'different' against the real HEAD, but materializing the approved
    // side's exact revision fails (no credential-bearing stderr may leak into the report).
    const candidateRevision = await commit('v1');
    // Not a hex SHA — this fails the fetch fast (invalid-looking revision), rather than a
    // well-formed-but-missing SHA1, which some local Git transports spend a long time
    // negotiating over before giving up.
    const bogusApprovedRevision = 'not-a-real-revision';
    const lock = makeLock({
      skill_dddddddd: lockedSkill(
        'Broken Skill',
        reference(bogusApprovedRevision, { remote: repoDir, ref: 'refs/heads/main' }),
      ),
    });
    const reporter = fakeReporter();
    const result = await runSkillCheck({ lock, workRoot, reporter });

    expect(result.checked).toHaveLength(1);
    expect(result.checked[0]).toMatchObject({
      entryId: 'skill_dddddddd',
      outcome: 'check-failed',
    });
    expect(result.checked[0]?.checkFailedReason).not.toContain(repoDir);
    expect(reporter.reportCalls).toHaveLength(1);
    const body = reporter.reportCalls[0]?.body;
    expect(body?.sourceCheckState).toBe('check-failed');
    expect(body?.failureReason).not.toContain(repoDir);
    expect(body?.failureReason).not.toContain(candidateRevision);
    expect(reporter.uploadCalls).toHaveLength(0);
  });

  it('reports update-available with NO artifact upload when bounds are exceeded', async () => {
    const approvedRevision = await commit('v1');
    const huge = 'x'.repeat(256 * 1024 + 1);
    await writeFile(path.join(repoDir, 'my-skill', 'big.md'), huge);
    const candidateRevision = await commit('v2');

    const lock = makeLock({
      skill_eeeeeeee: lockedSkill(
        'Big Skill',
        reference(approvedRevision, { remote: repoDir, ref: 'refs/heads/main' }),
      ),
    });
    const reporter = fakeReporter();
    const result = await runSkillCheck({ lock, workRoot, reporter });

    expect(result.checked).toEqual([
      {
        entryId: 'skill_eeeeeeee',
        name: 'Big Skill',
        outcome: 'update-available',
        exceedsBounds: true,
        candidateRevision,
      },
    ]);
    expect(reporter.uploadCalls).toHaveLength(0);
    expect(reporter.reportCalls).toHaveLength(1);
    expect(reporter.reportCalls[0]?.body).toMatchObject({
      sourceCheckState: 'check-failed',
    });
  });

  it('a selector checks only the named Skill', async () => {
    const revision = await commit('v1');
    const lock = makeLock({
      skill_ffffffff: lockedSkill(
        'Skill One',
        reference(revision, { remote: repoDir, ref: 'refs/heads/main' }),
      ),
      skill_gggggggg: lockedSkill('Skill Two', snapshot('local')),
    });
    const reporter = fakeReporter();
    const result = await runSkillCheck({
      lock,
      workRoot,
      reporter,
      selector: 'skill_ffffffff',
    });

    expect(result.checked).toHaveLength(1);
    expect(result.checked[0]?.entryId).toBe('skill_ffffffff');
  });

  it('with no selector, checks every checkable Skill', async () => {
    const revision = await commit('v1');
    const lock = makeLock({
      skill_hhhhhhhh: lockedSkill(
        'Skill One',
        reference(revision, { remote: repoDir, ref: 'refs/heads/main' }),
      ),
      skill_iiiiiiii: lockedSkill('Skill Two', snapshot('local')),
    });
    const reporter = fakeReporter();
    const result = await runSkillCheck({ lock, workRoot, reporter });

    const entryIds = result.checked.map((c) => c.entryId).sort();
    expect(entryIds).toEqual(['skill_hhhhhhhh', 'skill_iiiiiiii']);
  });

  it('never approves, installs, pauses, or resumes anything', async () => {
    const revision = await commit('v1');
    const lock = makeLock({
      skill_jjjjjjjj: lockedSkill(
        'Skill One',
        reference(revision, { remote: repoDir, ref: 'refs/heads/main' }),
      ),
    });
    // The fake exposes ONLY reportSkillSourceCheck/uploadSkillReviewArtifact — no
    // approve/pause/resume/install methods exist on it at all, so a call to any of them would
    // throw a TypeError rather than silently succeed.
    const reporter = fakeReporter();
    await expect(
      runSkillCheck({ lock, workRoot, reporter }),
    ).resolves.toBeDefined();
  });
});
