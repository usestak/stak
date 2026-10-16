import { describe, expect, it } from 'vitest';

import type { CloudService } from '@stack/cloud-server';
import type { MachineSummary } from '@stack/spec';

import { resolveSidebarMachineContext } from './sidebar-machine-context.js';

const nowIso = (minsAgo: number) =>
  new Date(Date.now() - minsAgo * 60_000).toISOString();

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: '00000000-0000-4000-8000-0000000000a1',
  name: 'Dell',
  platform: 'win32',
  arch: 'x64',
  agentsDetected: ['claude'],
  firstSeenAt: nowIso(60 * 24),
  lastCheckinAt: nowIso(12),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 1,
  ...over,
});

const service = (
  machines: MachineSummary[],
  throwOnRead = false,
): Pick<CloudService, 'getMachinesReadModel'> => ({
  getMachinesReadModel: async () => {
    if (throwOnRead) throw new Error('offline');
    return { machines };
  },
});

describe('resolveSidebarMachineContext', () => {
  it('resolves the viewing machine and the full switcher option list', async () => {
    const a = machine({ machineId: 'a', name: 'Dell' });
    const b = machine({ machineId: 'b', name: 'MacBook' });
    const ctx = await resolveSidebarMachineContext(
      service([a, b]),
      'user-1',
      'a',
    );
    expect(ctx.viewing?.machineId).toBe('a');
    expect(ctx.machines).toHaveLength(2);
    expect(ctx.activeCount).toBe(2);
  });

  it('excludes revoked machines from the active count and switcher', async () => {
    const a = machine({ machineId: 'a' });
    const revoked = machine({ machineId: 'b', revoked: true });
    const ctx = await resolveSidebarMachineContext(
      service([a, revoked]),
      'user-1',
      'a',
    );
    expect(ctx.activeCount).toBe(1);
    expect(ctx.machines).toHaveLength(1);
  });

  it('degrades gracefully (never throws) when the machine read fails', async () => {
    const ctx = await resolveSidebarMachineContext(
      service([], true),
      'user-1',
      undefined,
    );
    expect(ctx).toEqual({ machines: [], viewing: null, activeCount: 0 });
  });

  it('leaves viewing null when the requested machine id does not resolve (2+ machines, so the single-machine auto-select path cannot mask this)', async () => {
    const a = machine({ machineId: 'a' });
    const b = machine({ machineId: 'b', name: 'MacBook' });
    const ctx = await resolveSidebarMachineContext(
      service([a, b]),
      'user-1',
      'does-not-exist',
    );
    expect(ctx.viewing).toBeNull();
  });
});
