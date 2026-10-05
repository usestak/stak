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
  reportCheckin,
  type CheckinInputs,
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
