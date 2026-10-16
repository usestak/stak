import { describe, expect, it } from 'vitest';

import type {
  MachineSummary,
  MachinesReadModel,
  ProjectSummary,
} from '@stack/spec';

import {
  filterProjectRows,
  loadProjectsList,
  type ProjectsService,
} from './projects-data.js';

const USER = { id: 'user-1' };
const A1 = '00000000-0000-4000-8000-0000000000a1';
const nowIso = (minsAgo: number) =>
  new Date(Date.now() - minsAgo * 60_000).toISOString();

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: A1,
  name: 'Dell',
  platform: 'win32',
  arch: 'x64',
  agentsDetected: ['Claude Code'],
  firstSeenAt: nowIso(60 * 24 * 10),
  lastCheckinAt: nowIso(12),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 1,
  ...over,
});

const project = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  projectId: 'prj_abc',
  name: 'stak',
  lifecycle: 'active',
  presentOn: [A1],
  fileCount: 4,
  lastBackupAt: null,
  ...over,
});

const service = (opts: {
  machines?: MachineSummary[];
  projects?: ProjectSummary[];
  throwMachines?: boolean;
  throwProjects?: boolean;
}): ProjectsService => ({
  getMachinesReadModel: async (): Promise<MachinesReadModel> => {
    if (opts.throwMachines) throw new Error('offline');
    return { machines: opts.machines ?? [machine()] };
  },
  getProjectsReadModel: async () => {
    if (opts.throwProjects) throw new Error('offline');
    return { projects: opts.projects ?? [project()] };
  },
  // The shared sidebar summary degrades to blank badges on a read failure (by design —
  // see sidebar-summary.ts); this file's own assertions only cover `.projects`, which
  // this page overrides with its own `rows.length` regardless of the shared summary.
  getOverview: async () => {
    throw new Error('not exercised by this test file');
  },
  listUserStacks: async () => {
    throw new Error('not exercised by this test file');
  },
});

const ready = (view: Awaited<ReturnType<typeof loadProjectsList>>) => {
  if (view.kind !== 'ready')
    throw new Error(`expected ready, got ${view.kind}`);
  return view;
};

describe('loadProjectsList', () => {
  it('returns error when machines fail to load', async () => {
    const view = await loadProjectsList(
      service({ throwMachines: true }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('error');
  });

  it('returns no-machines with zero active machines', async () => {
    const view = await loadProjectsList(
      service({ machines: [machine({ revoked: true })] }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('no-machines');
  });

  it('returns a truthful empty state with zero Projects', async () => {
    const view = ready(
      await loadProjectsList(service({ projects: [] }), USER, A1),
    );
    expect(view.rows).toEqual([]);
    expect(view.statusSentence).not.toMatch(/writes memory/i);
  });

  it('marks a Project present on the viewing machine', async () => {
    const view = ready(
      await loadProjectsList(
        service({ projects: [project({ presentOn: [A1] })] }),
        USER,
        A1,
      ),
    );
    expect(view.rows[0]!.presence).toBe('On this machine');
  });

  it('marks a Project absent from the viewing machine', async () => {
    const view = ready(
      await loadProjectsList(
        service({ projects: [project({ presentOn: [] })] }),
        USER,
        A1,
      ),
    );
    expect(view.rows[0]!.presence).toBe('Not on this machine');
  });

  it('labels lifecycle Active/Archived using the frozen words', async () => {
    const view = ready(
      await loadProjectsList(
        service({
          projects: [
            project({ projectId: 'prj_1', lifecycle: 'active' }),
            project({ projectId: 'prj_2', lifecycle: 'archived' }),
          ],
        }),
        USER,
        A1,
      ),
    );
    const byId = new Map(view.rows.map((r) => [r.projectId, r.lifecycleLabel]));
    expect(byId.get('prj_1')).toBe('Active');
    expect(byId.get('prj_2')).toBe('Archived');
  });

  it('never labels fileCount null as zero (Protected-mode-derived unavailability)', async () => {
    const view = ready(
      await loadProjectsList(
        service({ projects: [project({ fileCount: null })] }),
        USER,
        A1,
      ),
    );
    expect(view.rows[0]!.fileCountLabel).toBe('Unavailable');
  });

  it('filters by lifecycle', async () => {
    const rows = ready(
      await loadProjectsList(
        service({
          projects: [
            project({ projectId: 'prj_1', lifecycle: 'active' }),
            project({ projectId: 'prj_2', lifecycle: 'archived' }),
          ],
        }),
        USER,
        A1,
      ),
    ).rows;
    expect(filterProjectRows(rows, 'archived', '')).toHaveLength(1);
    expect(filterProjectRows(rows, 'active', '')).toHaveLength(1);
    expect(filterProjectRows(rows, 'all', '')).toHaveLength(2);
  });

  it('filters by search query against the display name', async () => {
    const rows = ready(
      await loadProjectsList(
        service({
          projects: [
            project({ projectId: 'prj_1', name: 'stak' }),
            project({ projectId: 'prj_2', name: 'other' }),
          ],
        }),
        USER,
        A1,
      ),
    ).rows;
    expect(filterProjectRows(rows, 'all', 'sta')).toHaveLength(1);
  });

  it('computes a unique-else-id CLI selector per row', async () => {
    const view = ready(
      await loadProjectsList(
        service({
          projects: [
            project({ projectId: 'prj_1', name: 'api' }),
            project({ projectId: 'prj_2', name: 'api' }),
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.rows.every((r) => r.cliSelector === r.projectId)).toBe(true);
  });

  it('returns error when projects read model throws', async () => {
    const view = await loadProjectsList(
      service({ throwProjects: true }),
      USER,
      A1,
    );
    expect(view.kind).toBe('error');
  });
});
