import { describe, expect, it } from 'vitest';

import type { OverviewReadModel } from '@stack/spec';

import {
  loadSidebarSummary,
  type SidebarSummaryService,
} from './sidebar-summary.js';

const USER = { id: 'user-1' };

const overview = (
  over: Partial<OverviewReadModel> = {},
): OverviewReadModel => ({
  viewingMachineId: 'machine-a',
  lastBackupAt: '2026-01-01T00:00:00Z',
  skills: { total: 31, paused: 0, updatesAvailable: 0 },
  memory: { mode: 'standard', hasRecoveryMethod: true },
  projects: { total: 9, archived: 0 },
  machines: { total: 1, updatesWaiting: 0 },
  needsAttention: [],
  recentActivity: [],
  ...over,
});

const service = (opts: {
  overview?: OverviewReadModel;
  stakCount?: number;
  throwOverview?: boolean;
  throwStacks?: boolean;
}): SidebarSummaryService => ({
  getOverview: async () => {
    if (opts.throwOverview) throw new Error('offline');
    return opts.overview ?? overview();
  },
  listUserStacks: async () => {
    if (opts.throwStacks) throw new Error('offline');
    return {
      stacks: Array.from({ length: opts.stakCount ?? 0 }, (_, i) => ({
        stackId: `stack-${i}`,
        name: `stack-${i}`,
        description: '',
        skillCount: 0,
        updatedAt: null,
        versionNumber: 0,
      })),
    };
  },
});

describe('loadSidebarSummary', () => {
  it('returns all real counts when a viewing machine resolves', async () => {
    const counts = await loadSidebarSummary(
      service({ stakCount: 2 }),
      USER,
      'machine-a',
      1,
    );
    expect(counts.skills).toBe('31');
    expect(counts.memory).toEqual({ n: 'Backed up', tone: 'ready' });
    expect(counts.projects).toBe('9');
    expect(counts.machines).toBe('1');
    expect(counts.staks).toBe('2');
  });

  it('surfaces the attention count when needsAttention is non-empty', async () => {
    const counts = await loadSidebarSummary(
      service({
        overview: overview({
          needsAttention: [
            { kind: 'update-available', label: 'review-pr has an update' },
          ],
        }),
      }),
      USER,
      'machine-a',
      1,
    );
    expect(counts.overview).toEqual({ n: '1', tone: 'attention' });
  });

  it('never claims "Backed up" when no Cloud backup exists yet', async () => {
    const counts = await loadSidebarSummary(
      service({ overview: overview({ lastBackupAt: null }) }),
      USER,
      'machine-a',
      1,
    );
    expect(counts.memory).toEqual({ n: '', tone: 'neutral' });
  });

  it('returns blank-but-machines-count when no machine is resolved yet', async () => {
    const counts = await loadSidebarSummary(service({}), USER, null, 3);
    expect(counts).toEqual({
      overview: { n: '', tone: 'neutral' },
      skills: '',
      memory: { n: '', tone: 'neutral' },
      projects: '',
      machines: '3',
      staks: '',
    });
  });

  it('degrades to blank counts (never throws) if the overview read fails', async () => {
    const counts = await loadSidebarSummary(
      service({ throwOverview: true }),
      USER,
      'machine-a',
      2,
    );
    expect(counts.skills).toBe('');
    expect(counts.machines).toBe('2');
  });

  it('degrades to blank counts (never throws) if the stacks read fails', async () => {
    const counts = await loadSidebarSummary(
      service({ throwStacks: true }),
      USER,
      'machine-a',
      1,
    );
    expect(counts.staks).toBe('');
    // A partial failure degrades the WHOLE summary to blank (never a half-real,
    // half-blank sidebar that could look like a different kind of inconsistency).
    expect(counts.skills).toBe('');
  });
});
