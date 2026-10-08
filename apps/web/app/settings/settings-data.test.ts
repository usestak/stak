import { describe, expect, it } from 'vitest';

import type { MachineSummary, MemoryReadModel } from '@stack/spec';

import { loadSettingsView, type SettingsService } from './settings-data.js';

const USER = { id: 'user-1' };
const nowIso = (minsAgo: number) =>
  new Date(Date.now() - minsAgo * 60_000).toISOString();

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: '00000000-0000-4000-8000-0000000000a1',
  name: 'Dell',
  platform: 'win32',
  arch: 'x64',
  agentsDetected: ['Claude Code'],
  firstSeenAt: nowIso(60),
  lastCheckinAt: nowIso(5),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 2,
  ...over,
});

const memory = (over: Partial<MemoryReadModel> = {}): MemoryReadModel => ({
  mode: 'protected',
  latestBackupAt: nowIso(5),
  backups: [],
  recoveryMethods: [
    { type: 'passkey', label: 'Touch ID', createdAt: nowIso(60) },
  ],
  hasRecoveryMethod: true,
  perProject: null,
  ...over,
});

const service = (opts: {
  machines?: MachineSummary[];
  memory?: MemoryReadModel;
  throwMachines?: boolean;
  throwMemory?: boolean;
}): SettingsService => ({
  getMachinesReadModel: async () => {
    if (opts.throwMachines) throw new Error('boom');
    return { machines: opts.machines ?? [machine()] };
  },
  getMemoryReadModel: async () => {
    if (opts.throwMemory) throw new Error('boom');
    return opts.memory ?? memory();
  },
});

describe('loadSettingsView', () => {
  it('reports an error view if either read model fails', async () => {
    const view = await loadSettingsView(service({ throwMemory: true }), USER);
    expect(view.kind).toBe('error');
  });

  it('counts only non-revoked machines as active', async () => {
    const view = await loadSettingsView(
      service({ machines: [machine(), machine({ revoked: true })] }),
      USER,
    );
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') expect(view.activeMachineCount).toBe(1);
  });

  it('flags Protected with no recovery method as needing attention', async () => {
    const view = await loadSettingsView(
      service({
        memory: memory({ hasRecoveryMethod: false, recoveryMethods: [] }),
      }),
      USER,
    );
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') expect(view.recoveryNeedsAttention).toBe(true);
  });

  it('never flags recovery attention for Standard mode without a recovery method', async () => {
    const view = await loadSettingsView(
      service({
        memory: memory({
          mode: 'standard',
          hasRecoveryMethod: false,
          recoveryMethods: [],
        }),
      }),
      USER,
    );
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') expect(view.recoveryNeedsAttention).toBe(false);
  });

  it('passes through the real mode and recovery methods untouched', async () => {
    const view = await loadSettingsView(service({}), USER);
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.mode).toBe('protected');
      expect(view.recoveryMethods).toEqual([
        { type: 'passkey', label: 'Touch ID' },
      ]);
    }
  });
});
