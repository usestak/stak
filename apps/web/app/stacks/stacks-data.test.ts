import { describe, expect, it } from 'vitest';

import type {
  MachineSummary,
  MachinesReadModel,
  OwnedStackSummary,
  SkillSummary,
  SkillsReadModel,
} from '@stack/spec';

import { loadStacksView, type StacksService } from './stacks-data.js';

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

const owned = (over: Partial<OwnedStackSummary> = {}): OwnedStackSummary => ({
  name: 'main',
  environmentId: 'env_1',
  latestVersionNumber: 3,
  skillCount: 1,
  updatedAt: nowIso(30),
  ...over,
});

const skill = (over: Partial<SkillSummary> = {}): SkillSummary => ({
  skillId: 'test-first',
  name: 'test-first',
  approvedVersion: 'sha256:abcdef1234567890',
  paused: false,
  source: { kind: 'local', checkable: false },
  capability: { declared: false },
  sourceCheckState: 'not-checked',
  checkedAt: null,
  installs: [],
  ...over,
});

const service = (opts: {
  machines?: MachineSummary[];
  owned?: OwnedStackSummary[];
  skills?: SkillSummary[];
  throwMachines?: boolean;
  throwStacks?: boolean;
}): StacksService => ({
  getMachinesReadModel: async (): Promise<MachinesReadModel> => {
    if (opts.throwMachines) throw new Error('offline');
    return { machines: opts.machines ?? [machine()] };
  },
  getStacksReadModel: async () => {
    if (opts.throwStacks) throw new Error('offline');
    return { owned: opts.owned ?? [owned()] };
  },
  getSkillsReadModel: async (): Promise<SkillsReadModel> => ({
    environmentExists: true,
    skills: opts.skills ?? [skill()],
  }),
});

const ready = (view: Awaited<ReturnType<typeof loadStacksView>>) => {
  if (view.kind !== 'ready')
    throw new Error(`expected ready, got ${view.kind}`);
  return view;
};

describe('loadStacksView', () => {
  it('returns error when machines fail to load', async () => {
    const view = await loadStacksView(
      service({ throwMachines: true }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('error');
  });

  it('returns no-machines with zero active machines', async () => {
    const view = await loadStacksView(
      service({ machines: [machine({ revoked: true })] }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('no-machines');
  });

  it('returns error when the stacks read model throws', async () => {
    const view = await loadStacksView(service({ throwStacks: true }), USER, A1);
    expect(view.kind).toBe('error');
  });

  it('shows the owned Stack with real composition facts', async () => {
    const view = ready(
      await loadStacksView(
        service({ owned: [owned({ skillCount: 1 })], skills: [skill()] }),
        USER,
        A1,
      ),
    );
    expect(view.owned?.name).toBe('main');
    expect(view.owned?.skillCount).toBe(1);
    expect(view.owned?.skills[0]!.name).toBe('test-first');
    expect(view.owned?.skills[0]!.paused).toBe(false);
  });

  it('marks a paused Skill in the Stack distinctly', async () => {
    const view = ready(
      await loadStacksView(
        service({
          owned: [owned({ skillCount: 1 })],
          skills: [skill({ paused: true })],
        }),
        USER,
        A1,
      ),
    );
    expect(view.owned?.skills[0]!.paused).toBe(true);
  });

  it('renders a truthful empty Stack with zero Skills', async () => {
    const view = ready(
      await loadStacksView(
        service({ owned: [owned({ skillCount: 0 })], skills: [] }),
        USER,
        A1,
      ),
    );
    expect(view.owned?.skills).toEqual([]);
    expect(view.statusSentence).toMatch(/empty/i);
  });

  it('renders a deliberate empty state with no owned Stack', async () => {
    const view = ready(await loadStacksView(service({ owned: [] }), USER, A1));
    expect(view.owned).toBeNull();
    expect(view.statusSentence).toMatch(/don't have a Stack/i);
  });

  it('never exposes the raw environment digest as a primary value', async () => {
    const view = ready(
      await loadStacksView(
        service({ owned: [owned({ environmentId: 'env_secret_123' })] }),
        USER,
        A1,
      ),
    );
    expect(view.owned?.name).not.toContain('env_secret_123');
  });

  it('shows "No version yet" rather than coercing a null version to zero', async () => {
    const view = ready(
      await loadStacksView(
        service({ owned: [owned({ latestVersionNumber: null })] }),
        USER,
        A1,
      ),
    );
    expect(view.owned?.versionLabel).toBe('No version yet');
  });
});
