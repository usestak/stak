import { describe, expect, it } from 'vitest';

import type { MachineSummary, MachinesReadModel } from '@stack/spec';

import {
  NEW_MACHINE_STEPS,
  loadMachinesView,
  type MachinesService,
} from './machines-data.js';

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
  // Raw stored AgentIds (packages/spec/src/adapter.ts) — never the display name directly.
  agentsDetected: ['codex', 'claude'],
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

  it('shows a healthy up-to-date machine truthfully, scoped to its check-in time', async () => {
    const view = ready(
      await loadMachinesView(service({ machines: [machine()] }), USER, A1),
    );
    expect(view.cards[0]!.statusLabel).toMatch(/Up to date/);
    expect(view.cards[0]!.skillsLabel).toBe('Up to date · as of 12 min ago');
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
    expect(view.cards[0]!.skillsLabel).toBe(
      '2 updates waiting · as of 12 min ago',
    );
    expect(view.updatesWaitingCards).toHaveLength(1);
  });

  it('ties every per-machine fact to its own check-in time, not a live state claim', async () => {
    const view = ready(
      await loadMachinesView(
        service({ machines: [machine({ memoryBackedUp: false })] }),
        USER,
        A1,
      ),
    );
    const c = view.cards[0]!;
    // "Up to date"/"Backed up" alone would read as present-tense; every fact must name the
    // check-in explicitly so a reader cannot mistake it for a live connection (contract §1/§3).
    for (const label of [
      c.skillsLabel,
      c.projectsLabel,
      c.memoryLabel,
      c.agentsLabel,
    ])
      expect(label).toMatch(/as of/);
    expect(c.memoryLabel).not.toMatch(/\bhere\b/i);
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

  it('shows friendly agent display names, never raw lowercase ids', async () => {
    const view = ready(
      await loadMachinesView(
        service({
          machines: [machine({ agentsDetected: ['codex', 'claude'] })],
        }),
        USER,
        A1,
      ),
    );
    expect(view.cards[0]!.agentsLabel).toMatch(/Codex, Claude Code/);
    expect(view.cards[0]!.agentsLabel).not.toContain('codex');
    expect(view.cards[0]!.agentsLabel).not.toMatch(/\bclaude\b/);
  });

  it('shows zero reported Projects as a real, scoped measured fact (not invented uncertainty)', async () => {
    // `projectsPresent` is a required field of every check-in payload — not best-effort like
    // the separate Cloud Project-registry sync — so 0 on a checked-in machine is a genuine
    // measured fact, not an absence of reporting. The number stays; only its scope changes.
    const view = ready(
      await loadMachinesView(
        service({ machines: [machine({ projectsPresent: 0 })] }),
        USER,
        A1,
      ),
    );
    expect(view.cards[0]!.projectsLabel).toBe('0 projects · as of 12 min ago');
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

  it('never presents an incomplete CLI command as copy-pasteable', () => {
    // The real syntax is `stak project map <project> <directory>` — a bare `stak project map`
    // is not runnable as shown, so it must never be the step marked `copyable`.
    for (const step of NEW_MACHINE_STEPS)
      if (step.syntax.startsWith('stak project map'))
        expect(step.copyable).toBe(false);
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
