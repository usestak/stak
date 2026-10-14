import { describe, expect, it } from 'vitest';

import type {
  MachineSummary,
  MachinesReadModel,
  OwnedStackSummary,
  SkillSummary,
  SkillsReadModel,
  UserStackSummary,
} from '@stack/spec';

import { loadStacksView, type StacksService } from './staks-data.js';

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
  userStacks?: UserStackSummary[];
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
  listUserStacks: async () => ({ stacks: opts.userStacks ?? [] }),
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
    expect(view.statusSentence).toMatch(/don't have a STAK/i);
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

  it('presents the version number as normal product wording, not raw "vN"', async () => {
    const view = ready(
      await loadStacksView(
        service({ owned: [owned({ latestVersionNumber: 3 })] }),
        USER,
        A1,
      ),
    );
    expect(view.owned?.versionLabel).toBe('Version 3');
  });

  it("names the Stack as the user's own in the headline", async () => {
    const view = ready(
      await loadStacksView(
        service({ owned: [owned({ skillCount: 1 })], skills: [skill()] }),
        USER,
        A1,
      ),
    );
    expect(view.statusSentence).toBe('Your main STAK has 1 Skill.');
  });

  it('never carries machine-installed/reconciliation state into Stack composition', async () => {
    // A SkillSummary can legitimately describe update-available/installed-elsewhere facts
    // (those belong to the Skills workspace), but the Stack composition row is desired-state
    // only (contract §6/§17): `paused` from the resolved bundle, nothing else.
    const machineUpdatesWaiting = skill({
      sourceCheckState: 'update-available',
      candidateRevision: 'rev_1',
      reviewArtifactId: '00000000-0000-4000-8000-0000000000aa',
      installs: [
        { machineId: A1, name: 'Dell', installedVersion: 'sha256:oldoldold' },
      ],
    });
    const view = ready(
      await loadStacksView(
        service({
          owned: [owned({ skillCount: 1 })],
          skills: [machineUpdatesWaiting],
        }),
        USER,
        A1,
      ),
    );
    expect(view.owned?.skills[0]).toEqual({
      skillId: 'test-first',
      name: 'test-first',
      paused: false,
    });
  });

  it('keeps Stack composition identical regardless of which machine is viewing', async () => {
    const A2 = '00000000-0000-4000-8000-0000000000a2';
    const base = {
      owned: [owned({ skillCount: 1 })],
      skills: [skill()],
    };
    const viewingHealthy = ready(
      await loadStacksView(
        service({ ...base, machines: [machine({ machineId: A1 })] }),
        USER,
        A1,
      ),
    );
    const viewingBehind = ready(
      await loadStacksView(
        service({
          ...base,
          machines: [
            machine({
              machineId: A2,
              status: 'updates-waiting',
              updatesWaiting: ['test-first'],
            }),
          ],
        }),
        USER,
        A2,
      ),
    );
    expect(viewingHealthy.owned?.skills).toEqual(viewingBehind.owned?.skills);
  });

  it('lists saved (named) Stacks separately from the main Stack', async () => {
    const view = ready(
      await loadStacksView(
        service({
          userStacks: [
            {
              stackId: 'stack_1',
              name: 'frontend',
              description: '',
              skillCount: 2,
              updatedAt: nowIso(10),
              versionNumber: 1,
            },
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.savedStacks).toEqual([
      {
        stackId: 'stack_1',
        name: 'frontend',
        skillCount: 2,
        versionLabel: 'Version 1',
        updatedAtLabel: expect.any(String),
      },
    ]);
  });

  it('renders an empty saved-Stacks list truthfully, never fabricating a row', async () => {
    const view = ready(
      await loadStacksView(service({ userStacks: [] }), USER, A1),
    );
    expect(view.savedStacks).toEqual([]);
  });

  it('sorts saved Stacks by name', async () => {
    const view = ready(
      await loadStacksView(
        service({
          userStacks: [
            {
              stackId: 'stack_2',
              name: 'zeta',
              description: '',
              skillCount: 1,
              updatedAt: null,
              versionNumber: 1,
            },
            {
              stackId: 'stack_1',
              name: 'alpha',
              description: '',
              skillCount: 1,
              updatedAt: null,
              versionNumber: 1,
            },
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.savedStacks.map((s) => s.name)).toEqual(['alpha', 'zeta']);
  });
});
