import { describe, expect, it } from 'vitest';

import type { MachineSummary, MachinesReadModel } from '@stack/spec';

import { loadMachinesView, type MachinesService } from './machines-data.js';

const USER = { id: 'user-1' };
const A1 = '00000000-0000-4000-8000-0000000000a1';
const A2 = '00000000-0000-4000-8000-0000000000a2';
const nowIso = (minsAgo: number) =>
  new Date(Date.now() - minsAgo * 60_000).toISOString();

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: A1,
  name: 'Dell',
  platform: 'win32',
  arch: 'x64',
  agentsDetected: ['Claude Code', 'Codex'],
  firstSeenAt: nowIso(60 * 24 * 10),
  lastCheckinAt: nowIso(12),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 3,
  ...over,
});

const service = (opts: {
  machines?: MachineSummary[];
  throwMachines?: boolean;
  throwRevoke?: boolean;
}): MachinesService => ({
  getMachinesReadModel: async (): Promise<MachinesReadModel> => {
    if (opts.throwMachines) throw new Error('offline');
    return { machines: opts.machines ?? [machine()] };
  },
  revokeMachine: async (_user, machineId) => {
    if (opts.throwRevoke) throw new Error('offline');
    return { machineId, revoked: true };
  },
});

const ready = (view: Awaited<ReturnType<typeof loadMachinesView>>) => {
  if (view.kind !== 'ready')
    throw new Error(`expected ready, got ${view.kind}`);
  return view;
};

describe('loadMachinesView', () => {
  it('returns error when machines fail to load', async () => {
    const view = await loadMachinesView(
      service({ throwMachines: true }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('error');
  });

  it('returns no-machines with zero active machines', async () => {
    const view = await loadMachinesView(
      service({ machines: [machine({ revoked: true })] }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('no-machines');
  });

  it('excludes a revoked machine from the active list', async () => {
    const view = ready(
      await loadMachinesView(
        service({
          machines: [
            machine({ machineId: A1, revoked: false }),
            machine({ machineId: A2, name: 'Studio', revoked: true }),
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.cards).toHaveLength(1);
    expect(view.cards[0]!.machineId).toBe(A1);
  });

  it('shows a healthy up-to-date machine truthfully', async () => {
    const view = ready(
      await loadMachinesView(service({ machines: [machine()] }), USER, A1),
    );
    expect(view.cards[0]!.statusLabel).toMatch(/Up to date/);
    expect(view.cards[0]!.skillsLabel).toBe('Up to date');
    expect(view.cards[0]!.stale).toBe(false);
  });

  it('surfaces updates waiting without inventing a connectivity claim', async () => {
    const view = ready(
      await loadMachinesView(
        service({
          machines: [
            machine({ status: 'updates-waiting', updatesWaiting: ['a', 'b'] }),
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.cards[0]!.skillsLabel).toBe('2 updates waiting');
    expect(view.updatesWaitingCards).toHaveLength(1);
  });

  it('flags a machine stale past the frozen 30-day threshold', async () => {
    const view = ready(
      await loadMachinesView(
        service({
          machines: [machine({ lastCheckinAt: nowIso(60 * 24 * 31) })],
        }),
        USER,
        A1,
      ),
    );
    expect(view.cards[0]!.stale).toBe(true);
  });

  it('never coerces never-checked-in facts to zero', async () => {
    const view = ready(
      await loadMachinesView(
        service({
          machines: [
            machine({
              status: 'never-checked-in',
              lastCheckinAt: null,
              projectsPresent: 0,
              memoryBackedUp: false,
              agentsDetected: [],
            }),
          ],
        }),
        USER,
        A1,
      ),
    );
    const c = view.cards[0]!;
    expect(c.skillsLabel).toBe('No check-in yet');
    expect(c.projectsLabel).toBe('No check-in yet');
    expect(c.memoryLabel).toBe('No check-in yet');
    expect(c.agentsLabel).toBe('No check-in yet');
  });

  it('handles multiple machines and sorts attention-needing first', async () => {
    const view = ready(
      await loadMachinesView(
        service({
          machines: [
            machine({ machineId: A1, name: 'Dell', status: 'up-to-date' }),
            machine({
              machineId: A2,
              name: 'Studio',
              status: 'updates-waiting',
              updatesWaiting: ['x'],
            }),
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.cards).toHaveLength(2);
    expect(view.cards[0]!.name).toBe('Studio');
  });

  it('warns the caller when there is only one active machine', async () => {
    const view = ready(
      await loadMachinesView(service({ machines: [machine()] }), USER, A1),
    );
    expect(view.cards[0]!.isOnlyActiveMachine).toBe(true);
  });

  it('does not warn when multiple active machines exist', async () => {
    const view = ready(
      await loadMachinesView(
        service({
          machines: [
            machine({ machineId: A1 }),
            machine({ machineId: A2, name: 'Studio' }),
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.cards.every((c) => c.isOnlyActiveMachine === false)).toBe(true);
  });

  it('falls back to friendly-name text for an unnamed machine', async () => {
    const view = ready(
      await loadMachinesView(
        service({ machines: [machine({ name: undefined })] }),
        USER,
        A1,
      ),
    );
    expect(view.cards[0]!.name).toBe('Unnamed machine');
  });

  it('displays a friendly platform label', async () => {
    const view = ready(
      await loadMachinesView(
        service({ machines: [machine({ platform: 'darwin' })] }),
        USER,
        A1,
      ),
    );
    expect(view.cards[0]!.meta).toMatch(/macOS/);
  });
});
