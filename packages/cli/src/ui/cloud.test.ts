import { describe, expect, it } from 'vitest';

import type { MemoryBackupOutcome } from '../memory/cloud-ops.js';
import {
  renderCombinedPullResult,
  renderCombinedPushResult,
  type PullMemoryOutcome,
  type PullSkillOutcome,
  type PushMemoryOutcome,
  type PushSkillOutcome,
} from './cloud.js';

const localBackup = { provider: 'claude' as const, files: 3, projects: 1, createdAt: '2026-01-01T00:00:00.000Z' };

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
    const outcome: MemoryBackupOutcome = {
      local: localBackup,
      cloud: { status: 'standard', generation: 5 },
    };
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
      outcome: { local: localBackup, cloud: { status: 'failed', message: 'offline' } },
    };
    const output = renderCombinedPushResult(skill, memory);
    expect(output).toContain('main created in the cloud');
    expect(output).toContain('Cloud sync FAILED: offline');
    expect(output).not.toContain('Push complete.');
  });
});

describe('renderCombinedPullResult', () => {
  it('reports a clean fresh-machine recovery', () => {
    const skill: PullSkillOutcome = {
      status: 'applied',
      result: { status: 'restored', desiredSkills: 12, digest: `sha256:${'a'.repeat(64)}` } as never,
    };
    const memory: PullMemoryOutcome = {
      status: 'applied',
      outcome: { status: 'recovered', privacyMode: 'standard', objects: 10, files: 14, generation: 3 },
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
