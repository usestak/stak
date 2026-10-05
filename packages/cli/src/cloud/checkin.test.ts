import { describe, expect, it, vi } from 'vitest';

import {
  CloudUnauthorizedError,
  CloudUnavailableError,
  NotAuthenticatedError,
  type CloudClient,
} from '@stack/cloud-client';
import type { MachineCheckinRequest } from '@stack/spec';

import {
  buildCheckinPayload,
  gatherCheckinInputs,
  installedSkillsFrom,
  nativeMemoryBackedUp,
  projectPresenceFrom,
  projectSyncPayloadFrom,
  reportCheckin,
  type CheckinInputs,
  type SkillStatusLike,
} from './checkin.js';

const inputs = (over: Partial<CheckinInputs> = {}): CheckinInputs => ({
  machineId: '00000000-0000-4000-8000-000000000001',
  name: 'atlas',
  platform: 'darwin',
  arch: 'arm64',
  agentsDetected: ['claude', 'codex'],
  memoryBackedUp: true,
  skills: [{ skillId: 'review-pr', installedVersion: 'sha256:aaa' }],
  projects: [{ projectId: 'prj_a', present: true }],
  ...over,
});

const clientWith = (
  machineCheckin: (r: MachineCheckinRequest) => Promise<unknown>,
): Pick<CloudClient, 'machineCheckin'> => ({
  machineCheckin: machineCheckin as CloudClient['machineCheckin'],
});

describe('buildCheckinPayload (P1)', () => {
  it('maps inputs to a presence-only payload', () => {
    const payload = buildCheckinPayload(inputs());
    expect(payload.machineId).toBe('00000000-0000-4000-8000-000000000001');
    expect(payload.memoryBackedUp).toBe(true);
    expect(payload.projects).toEqual([{ projectId: 'prj_a', present: true }]);
    // Project entries carry ONLY projectId + present (no path key).
    expect(Object.keys(payload.projects[0] ?? {}).sort()).toEqual([
      'present',
      'projectId',
    ]);
  });

  it('carries no filesystem paths and no Memory content', () => {
    const payload = buildCheckinPayload(
      inputs({
        projects: [
          { projectId: 'prj_a', present: true },
          { projectId: 'prj_b', present: false },
        ],
      }),
    );
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/\/Users\//);
    expect(serialized).not.toMatch(/[A-Za-z]:\\\\/);
    expect(serialized).not.toContain('~/');
    // No Memory CONTENT (the `memoryBackedUp` boolean flag is fine — it is not content).
    expect(serialized.toLowerCase()).not.toContain('manifest');
    expect(serialized).not.toContain('contentHash');
    // Only the whitelisted keys appear.
    expect(Object.keys(payload).sort()).toEqual([
      'agentsDetected',
      'arch',
      'machineId',
      'memoryBackedUp',
      'name',
      'platform',
      'projects',
      'skills',
    ]);
  });
});

describe('reportCheckin (P1)', () => {
  it('reports successfully and returns ok', async () => {
    const machineCheckin = vi.fn(async () => ({ ok: true }));
    const result = await reportCheckin({
      client: clientWith(machineCheckin),
      inputs: inputs(),
    });
    expect(result).toEqual({ status: 'ok' });
    expect(machineCheckin).toHaveBeenCalledOnce();
  });

  it('is non-fatal when the Cloud is unreachable (connectivity)', async () => {
    const result = await reportCheckin({
      client: clientWith(async () => {
        throw new CloudUnavailableError('offline');
      }),
      inputs: inputs(),
    });
    expect(result).toEqual({ status: 'skipped' });
  });

  it('is non-fatal on an unexpected/transient error', async () => {
    const result = await reportCheckin({
      client: clientWith(async () => {
        throw new Error('boom');
      }),
      inputs: inputs(),
    });
    expect(result).toEqual({ status: 'skipped' });
  });

  it('re-throws a 401 (not treated as offline)', async () => {
    await expect(
      reportCheckin({
        client: clientWith(async () => {
          throw new NotAuthenticatedError('nope');
        }),
        inputs: inputs(),
      }),
    ).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it('re-throws a 403 (not treated as offline)', async () => {
    await expect(
      reportCheckin({
        client: clientWith(async () => {
          throw new CloudUnauthorizedError('revoked');
        }),
        inputs: inputs(),
      }),
    ).rejects.toBeInstanceOf(CloudUnauthorizedError);
  });
});

describe('gatherCheckinInputs (P1)', () => {
  const machine = async () => ({
    machineId: '00000000-0000-4000-8000-000000000001',
    platform: 'linux',
    arch: 'x64',
  });

  it('assembles inputs and uses the injected hostname', async () => {
    const got = await gatherCheckinInputs({
      machine,
      hostname: () => 'studio',
      memoryBackedUp: async () => true,
      installedSkills: async () => [
        { skillId: 's', installedVersion: 'sha256:1' },
      ],
      projectPresence: async () => [{ projectId: 'prj_a', present: false }],
      agentsDetected: async () => ['codex'],
    });
    expect(got).toEqual({
      machineId: '00000000-0000-4000-8000-000000000001',
      platform: 'linux',
      arch: 'x64',
      name: 'studio',
      memoryBackedUp: true,
      skills: [{ skillId: 's', installedVersion: 'sha256:1' }],
      projects: [{ projectId: 'prj_a', present: false }],
      agentsDetected: ['codex'],
    });
  });

  it('a failing reader degrades to an empty section, never throwing', async () => {
    const got = await gatherCheckinInputs({
      machine,
      hostname: () => 'studio',
      memoryBackedUp: async () => {
        throw new Error('no manifest');
      },
      installedSkills: async () => {
        throw new Error('no environment');
      },
      projectPresence: async () => {
        throw new Error('no registry');
      },
      agentsDetected: async () => {
        throw new Error('no agents');
      },
    });
    expect(got.memoryBackedUp).toBe(false);
    expect(got.skills).toEqual([]);
    expect(got.projects).toEqual([]);
    expect(got.agentsDetected).toEqual([]);
    expect(got.machineId).toBe('00000000-0000-4000-8000-000000000001');
  });
});

describe('installedSkillsFrom (P1 review #2 — stable skill identity)', () => {
  it('keys by stable entryId and uses the on-disk hash (satisfied → desired, modified → current)', () => {
    const statuses: SkillStatusLike[] = [
      {
        entryId: 'skill_aaaaaaaa',
        state: 'satisfied',
        desiredHash: 'sha256:d1',
      },
      {
        entryId: 'skill_bbbbbbbb',
        state: 'modified',
        desiredHash: 'sha256:d2',
        currentHash: 'sha256:c2',
      },
    ];
    expect(installedSkillsFrom(statuses)).toEqual([
      { skillId: 'skill_aaaaaaaa', installedVersion: 'sha256:d1' },
      { skillId: 'skill_bbbbbbbb', installedVersion: 'sha256:c2' },
    ]);
  });

  it('two skills sharing a display name but distinct ids do not collapse', () => {
    // Same human name "review-pr" at two distinct stable entry ids.
    const statuses: SkillStatusLike[] = [
      {
        entryId: 'skill_dup00001',
        state: 'satisfied',
        desiredHash: 'sha256:x',
      },
      {
        entryId: 'skill_dup00002',
        state: 'satisfied',
        desiredHash: 'sha256:y',
      },
    ];
    const installed = installedSkillsFrom(statuses);
    expect(installed).toHaveLength(2);
    expect(installed.map((s) => s.skillId).sort()).toEqual([
      'skill_dup00001',
      'skill_dup00002',
    ]);
  });

  it('missing and uncertain skills are not reported as installed', () => {
    const statuses: SkillStatusLike[] = [
      { entryId: 'skill_missing0', state: 'missing', desiredHash: 'sha256:m' },
      {
        entryId: 'skill_uncertn0',
        state: 'uncertain',
        desiredHash: 'sha256:u',
      },
    ];
    expect(installedSkillsFrom(statuses)).toEqual([]);
  });
});

describe('projectPresenceFrom (P1 review #1 — real availability)', () => {
  it('maps availability to presence (never a path)', () => {
    expect(
      projectPresenceFrom([
        { projectId: 'prj_a', availability: 'present' },
        { projectId: 'prj_b', availability: 'unavailable' },
      ]),
    ).toEqual([
      { projectId: 'prj_a', present: true },
      { projectId: 'prj_b', present: false },
    ]);
  });
});

describe('projectSyncPayloadFrom (P3 review §5 — no path leaks into the name)', () => {
  it('names a project only from a strong Git identity, never a local path/vendorKey', () => {
    const payload = projectSyncPayloadFrom([
      {
        projectId: 'prj_git',
        identity: { kind: 'git', canonical: 'github.com/acme/atlas' },
      },
      {
        // An adversarial local identity whose vendor key is derived from an absolute path.
        projectId: 'prj_local',
        identity: { kind: 'local', vendorKey: 'C--Users-dana-secret-work' },
      },
    ]);
    expect(payload).toEqual([
      { projectId: 'prj_git', name: 'github.com/acme/atlas' },
      { projectId: 'prj_local' }, // no name — the path-derived vendor key is never sent
    ]);
    // Nothing path-like leaked anywhere in the serialized payload.
    expect(JSON.stringify(payload)).not.toMatch(
      /C--Users|\/Users\/|[A-Za-z]:\\\\/,
    );
  });
});

describe('nativeMemoryBackedUp (P1 review #3 — truthful backup state)', () => {
  const native = [
    { logicalId: 'claude/auto-memory/p/a.md', contentHash: 'sha256:a' },
    { logicalId: 'claude/auto-memory/p/b.md', contentHash: 'sha256:b' },
  ];

  it('A. native identical to the latest backup → true', () => {
    expect(nativeMemoryBackedUp(native, [...native])).toBe(true);
  });

  it('B. a native file changed since the backup → false', () => {
    const manifest = [
      { logicalId: 'claude/auto-memory/p/a.md', contentHash: 'sha256:OLD' },
      { logicalId: 'claude/auto-memory/p/b.md', contentHash: 'sha256:b' },
    ];
    expect(nativeMemoryBackedUp(native, manifest)).toBe(false);
  });

  it('B2. a new native file not in the backup → false', () => {
    const manifest = [
      { logicalId: 'claude/auto-memory/p/a.md', contentHash: 'sha256:a' },
    ];
    expect(nativeMemoryBackedUp(native, manifest)).toBe(false);
  });

  it('C. never backed up (no manifest) → false', () => {
    expect(nativeMemoryBackedUp(native, null)).toBe(false);
  });
});
