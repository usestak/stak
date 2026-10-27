import { describe, expect, it } from 'vitest';

import type { CloudRecoverOutcome } from '../memory/cloud-ops.js';
import {
  pullFailed,
  renderCombinedPullResult,
  renderCombinedPushResult,
  type MemoryPushOutcome,
  type PullMemoryOutcome,
  type PullSkillOutcome,
  type PushMemoryOutcome,
  type PushSkillOutcome,
} from './cloud.js';

describe('renderCombinedPushResult', () => {
  it('reports a clean, fully-synced push', () => {
    const skill: PushSkillOutcome = {
      status: 'applied',
      result: {
        environment: 'main',
        versionId: '00000000-0000-4000-8000-000000000001',
        versionNumber: 2,
        digest: `sha256:${'a'.repeat(64)}`,
        createdNew: false,
        uploaded: 0,
      },
    };
    const outcome: MemoryPushOutcome = { status: 'standard', generation: 5 };
    const memory: PushMemoryOutcome = { status: 'applied', outcome };
    const output = renderCombinedPushResult(skill, memory);
    expect(output).toContain('Skills');
    expect(output).toContain('Memory');
    expect(output).toContain('generation 5');
    expect(output).toContain('Push complete.');
    expect(output).not.toContain('FAILED');
  });

  it('never claims success when the Skill push failed', () => {
    const skill: PushSkillOutcome = { status: 'failed', error: 'network down' };
    const memory: PushMemoryOutcome = { status: 'not-attempted' };
    const output = renderCombinedPushResult(skill, memory);
    expect(output).toContain('FAILED: network down');
    expect(output).not.toContain('Push complete.');
    expect(output).toContain('did not fully succeed');
  });

  it('never claims success when Memory Cloud sync failed even though Skills succeeded', () => {
    const skill: PushSkillOutcome = {
      status: 'applied',
      result: {
        environment: 'main',
        versionId: '00000000-0000-4000-8000-000000000001',
        versionNumber: 1,
        digest: `sha256:${'a'.repeat(64)}`,
        createdNew: true,
        uploaded: 2,
      },
    };
    const memory: PushMemoryOutcome = {
      status: 'applied',
      outcome: { status: 'failed', message: 'offline' },
    };
    const output = renderCombinedPushResult(skill, memory);
    expect(output).toContain('main created in the cloud');
    expect(output).toContain('Cloud sync FAILED: offline');
    expect(output).not.toContain('Push complete.');
  });

  it('tells the user to `stak add .` when nothing is staged yet — a total no-op says "Nothing to push.", not "Push complete."', () => {
    const skill: PushSkillOutcome = { status: 'noop' };
    const memory: PushMemoryOutcome = {
      status: 'applied',
      outcome: { status: 'nothing-staged' },
    };
    const output = renderCombinedPushResult(skill, memory);
    expect(output).toContain('nothing staged yet');
    expect(output).toContain('stak add .');
    expect(output).toContain('Nothing to push.');
    expect(output).not.toContain('Push complete.');
  });

  it('reports Memory already up to date without claiming a new generation was created', () => {
    const skill: PushSkillOutcome = { status: 'noop' };
    const memory: PushMemoryOutcome = {
      status: 'applied',
      outcome: { status: 'up-to-date', generation: 6 },
    };
    const output = renderCombinedPushResult(skill, memory);
    expect(output).toContain('already up to date (generation 6)');
    expect(output).not.toContain('synced to Cloud (generation 6)');
    expect(output).toContain('Nothing to push.');
  });

  it('says "Push complete." (not "Nothing to push.") when Skills actually changed even if Memory was already up to date', () => {
    const skill: PushSkillOutcome = {
      status: 'applied',
      result: {
        environment: 'main',
        versionId: '00000000-0000-4000-8000-000000000001',
        versionNumber: 2,
        digest: `sha256:${'a'.repeat(64)}`,
        createdNew: false,
        uploaded: 1,
      },
    };
    const memory: PushMemoryOutcome = {
      status: 'applied',
      outcome: { status: 'up-to-date', generation: 6 },
    };
    const output = renderCombinedPushResult(skill, memory);
    expect(output).toContain('Push complete.');
    expect(output).not.toContain('Nothing to push.');
  });
});

describe('renderCombinedPullResult', () => {
  it('reports a clean fresh-machine recovery', () => {
    const skill: PullSkillOutcome = {
      status: 'applied',
      result: {
        status: 'restored',
        desiredSkills: 12,
        digest: `sha256:${'a'.repeat(64)}`,
      } as never,
    };
    const memory: PullMemoryOutcome = {
      status: 'applied',
      outcome: {
        status: 'recovered',
        privacyMode: 'standard',
        objects: 10,
        files: 14,
        generation: 3,
      },
    };
    const output = renderCombinedPullResult(skill, memory);
    expect(output).toContain('14');
    expect(output).toContain('generation 3');
    expect(output).not.toContain('FAILED');
  });

  it('explains why Memory was skipped on an established machine', () => {
    const skill: PullSkillOutcome = { status: 'noop' };
    const memory: PullMemoryOutcome = {
      status: 'skipped',
      reason: 'Local Memory already exists on this machine.',
    };
    const output = renderCombinedPullResult(skill, memory);
    expect(output).toContain('Local Memory already exists');
    expect(output).toContain('stak memory recover');
  });
});

describe('pullFailed (fresh-machine Memory outcomes)', () => {
  const restored: PullSkillOutcome = {
    status: 'applied',
    result: {
      status: 'restored',
      desiredSkills: 2,
      digest: `sha256:${'a'.repeat(64)}`,
    } as never,
  };
  const applied = (outcome: CloudRecoverOutcome): PullMemoryOutcome => ({
    status: 'applied',
    outcome,
  });

  it('no Cloud Memory backup yet (a Skills-only account on a new machine) is not a failure', () => {
    const memory = applied({ status: 'no-backup' });
    expect(pullFailed(restored, memory)).toBe(false);
    const output = renderCombinedPullResult(restored, memory);
    expect(output).toContain('no Cloud Memory backup exists yet.');
    expect(output).toContain('Pull complete.');
    expect(output).not.toContain('did not fully succeed');
  });

  it('locked Protected Memory is the same friendly, non-failing status push gives `protected-locked`', () => {
    const memory = applied({ status: 'needs-recovery-method' });
    expect(pullFailed(restored, memory)).toBe(false);
    expect(renderCombinedPullResult(restored, memory)).toContain(
      'needs a recovery method',
    );
  });

  it('not signed in is not a failure, like push reporting `skipped`', () => {
    expect(pullFailed(restored, applied({ status: 'not-authenticated' }))).toBe(
      false,
    );
  });

  it('a genuine Memory error is still a failure', () => {
    const memory: PullMemoryOutcome = {
      status: 'failed',
      error: 'network down',
    };
    expect(pullFailed(restored, memory)).toBe(true);
    const output = renderCombinedPullResult(restored, memory);
    expect(output).toContain('FAILED: network down');
    expect(output).toContain('Pull did not fully succeed.');
  });

  it('a Skills failure is still a failure even when Memory has no backup', () => {
    expect(
      pullFailed(
        { status: 'failed', error: 'offline' },
        applied({ status: 'no-backup' }),
      ),
    ).toBe(true);
  });
});

describe('local Memory conflicts after a pull (final review I4)', () => {
  it('does not claim `stak add .` resolves them; points at `stak status` and names the files', () => {
    const skill: PullSkillOutcome = { status: 'noop' };
    const memory: PullMemoryOutcome = { status: 'not-attempted' };
    const output = renderCombinedPullResult(skill, memory, {
      status: 'applied',
      outcome: {
        status: 'merged',
        conflicts: [
          {
            projectId: 'prj_demo',
            path: 'notes/MEMORY.md',
            reason: 'adopt-mismatch',
          },
        ],
      },
    });
    expect(output).not.toContain('need `stak add .` to resolve');
    expect(output).toContain('notes/MEMORY.md');
    expect(output).toContain('stak status');
  });
});
