import { describe, expect, it } from 'vitest';

import type {
  EnvironmentDiff,
  EnvironmentStatus,
  SkillStatus,
} from '@stack/spec';

import { renderDiff, renderStatus } from './environment.js';

const baseSummary: EnvironmentStatus['summary'] = {
  satisfied: 0,
  modified: 0,
  missing: 0,
  notInstalled: 0,
  uncertain: 0,
  untracked: 0,
  placementAdded: 0,
  placementRemoved: 0,
  placementChanged: 0,
  invalid: 0,
  rootFailures: 0,
  preservation: { available: 0, missing: 0, corrupt: 0 },
  restoration: { reference: 0, snapshot: 0 },
};

const skillStatus = (
  overrides: Partial<SkillStatus> &
    Pick<SkillStatus, 'entryId' | 'name' | 'state'>,
): SkillStatus => ({
  desiredHash:
    'sha256:0000000000000000000000000000000000000000000000000000000000000'.slice(
      0,
      71,
    ),
  baselineLocations: [],
  currentLocations: [],
  uncertaintyRoots: [],
  preservation: {
    state: 'available',
    contentHash: 'sha256:0'.padEnd(71, '0'),
    objectPath: '/x',
  },
  restorationStrategy: 'snapshot',
  ...overrides,
});

const baseStatus = (
  overrides: Partial<EnvironmentStatus> = {},
): EnvironmentStatus => ({
  schemaVersion: 1,
  environment: 'main',
  observedAt: new Date(0).toISOString(),
  desiredCount: 0,
  skills: [],
  untracked: [],
  placementDrift: [],
  invalidSkills: [],
  rootFailures: [],
  summary: baseSummary,
  ...overrides,
});

describe('renderStatus — Memory section (MACHINE vs MAIN, not Cloud)', () => {
  const cleanStatus = baseStatus({ summary: { ...baseSummary, satisfied: 1 } });

  it('reports files discovered before anything has been staged', () => {
    const output = renderStatus(cleanStatus, {
      memory: { state: 'no-manifest', discovered: 14 },
    });
    expect(output).toContain('Memory');
    expect(output).toContain('14 files discovered');
  });

  it('reports clean when native Memory matches what was staged', () => {
    const output = renderStatus(cleanStatus, { memory: { state: 'clean' } });
    expect(output).toContain('clean');
  });

  it('reports changes not added when native Memory diverges from the staged manifest', () => {
    const output = renderStatus(cleanStatus, {
      memory: { state: 'changes-not-added', changed: 3 },
    });
    expect(output).toContain('3 changes not added');
  });

  it('omits the Memory section entirely when no Memory state was supplied', () => {
    const output = renderStatus(cleanStatus);
    expect(output).not.toContain('Memory');
  });
});

describe('renderStatus — local Memory conflicts (final review I4)', () => {
  const cleanStatus = baseStatus({ summary: { ...baseSummary, satisfied: 1 } });
  const project = (
    conflicts: { path: string; reason: string }[],
    sourceConflicts: string[] = [],
  ) => ({
    projectId: 'prj_demo',
    imported: [],
    pending: 0,
    conflicts,
    sourceConflicts,
    guardedPaths: [],
  });

  it('never sends a local conflict to `stak memory resolve`, and gives the action that clears each kind', () => {
    const output = renderStatus(cleanStatus, {
      memory: {
        state: 'clean',
        canonicalProjects: [
          project(
            [
              { path: 'notes/MEMORY.md', reason: 'adopt-mismatch' },
              { path: 'notes/old.md', reason: 'edit-delete' },
              { path: 'notes/both.md', reason: 'edit-edit' },
            ],
            ['notes/moved.md'],
          ),
        ],
      },
    });
    expect(output).not.toContain('stak memory resolve');
    expect(output).toContain('notes/MEMORY.md');
    expect(output).toMatch(
      /notes\/MEMORY\.md.*move the file somewhere else, then run `stak memory materialize`/,
    );
    expect(output).toMatch(/notes\/old\.md.*deleted in STAK/);
    expect(output).toMatch(/notes\/moved\.md.*old and current Claude folders/);
    expect(output).toMatch(
      /notes\/both\.md.*can't settle this one automatically yet/,
    );
  });
});

describe('renderStatus — Cloud section', () => {
  const cleanStatus = baseStatus({ summary: { ...baseSummary, satisfied: 1 } });

  it('shows up to date, explicitly scoped to Skills', () => {
    const output = renderStatus(cleanStatus, {
      cloud: { status: 'up-to-date' },
    });
    expect(output).toContain('Cloud');
    expect(output).toContain('Skills');
    expect(output).toContain('up to date with main');
  });

  it('shows main has changes to push', () => {
    const output = renderStatus(cleanStatus, { cloud: { status: 'ahead' } });
    expect(output).toContain('main has changes to push');
  });

  it('shows a newer version is available and points to pull', () => {
    const output = renderStatus(cleanStatus, {
      cloud: { status: 'behind', remoteVersionNumber: 4 },
    });
    expect(output).toContain('newer version available');
    expect(output).toContain('stak pull');
  });

  it('shows nothing pushed yet', () => {
    const output = renderStatus(cleanStatus, {
      cloud: { status: 'no-remote' },
    });
    expect(output).toContain('nothing pushed yet');
  });

  it('shows diverged with guidance', () => {
    const output = renderStatus(cleanStatus, { cloud: { status: 'diverged' } });
    expect(output).toContain('diverged');
  });

  it('shows not checked and never fails when offline/unauthenticated', () => {
    const offline = renderStatus(cleanStatus, {
      cloud: { status: 'not-checked', reason: 'offline' },
    });
    expect(offline).toContain('not checked');
    const unauth = renderStatus(cleanStatus, {
      cloud: { status: 'not-checked', reason: 'unauthenticated' },
    });
    expect(unauth).toContain('not checked');
  });

  it('reports a data/compatibility read failure distinctly from offline', () => {
    const output = renderStatus(cleanStatus, {
      cloud: { status: 'unavailable' },
    });
    expect(output).toContain('unavailable');
    expect(output).toContain('Cloud response could not be read');
    expect(output).not.toContain('offline');
  });

  it('omits the Cloud section entirely when no cloud state was supplied', () => {
    const output = renderStatus(cleanStatus);
    expect(output).not.toContain('Cloud');
  });

  it('never claims the overall STAK is up to date when Skills are synced but Memory is not — scopes each line separately', () => {
    const output = renderStatus(cleanStatus, {
      cloud: { status: 'up-to-date' },
      memoryCloud: {
        status: 'backed-up',
        generation: 4,
        historicalRecovery: false,
      },
    });
    expect(output).toContain('Skills');
    expect(output).toContain('up to date with main');
    expect(output).toContain('Memory');
    expect(output).toContain('backed up (generation 4)');
  });

  it('shows nothing pushed yet for Memory distinctly from Skills', () => {
    const output = renderStatus(cleanStatus, {
      cloud: { status: 'up-to-date' },
      memoryCloud: { status: 'no-backup' },
    });
    expect(output).toMatch(/Memory\s+nothing pushed yet/);
  });

  it('shows Memory Cloud state as not checked without failing', () => {
    const output = renderStatus(cleanStatus, {
      cloud: { status: 'not-checked', reason: 'offline' },
      memoryCloud: { status: 'not-checked' },
    });
    expect(output).toMatch(/Memory\s+not checked/);
  });
});

describe('renderStatus (default, non-verbose)', () => {
  it('reports a clean tree when nothing is untracked, modified, or missing', () => {
    const status = baseStatus({
      desiredCount: 31,
      skills: Array.from({ length: 31 }, (_, index) =>
        skillStatus({
          entryId: `skill_${index}`,
          name: `skill-${index}`,
          state: 'satisfied',
        }),
      ),
      summary: { ...baseSummary, satisfied: 31 },
    });
    const output = renderStatus(status);
    expect(output).toContain('Nothing to add');
    expect(output).not.toContain('Changes not added');
  });

  it('surfaces an untracked Skill by name — the confirmed renderer-bug regression case', () => {
    // Regression test for the "32 scanned / 31 tracked / status says no changes" bug: status
    // already computes `untracked`, the default renderer just has to show it.
    const status = baseStatus({
      desiredCount: 31,
      skills: Array.from({ length: 31 }, (_, index) =>
        skillStatus({
          entryId: `skill_${index}`,
          name: `skill-${index}`,
          state: 'satisfied',
        }),
      ),
      untracked: [
        {
          name: 'new-skill',
          contentHash: 'sha256:1'.padEnd(71, '0'),
          source: { type: 'local' },
          locations: [],
        },
      ],
      summary: { ...baseSummary, satisfied: 31, untracked: 1 },
    });
    const output = renderStatus(status);
    expect(output).toContain('Changes not added');
    expect(output).toContain('+ new-skill');
    expect(output).toMatch(/31 tracked/);
    expect(output).toMatch(/1 untracked/);
  });

  it('surfaces a modified tracked Skill by name', () => {
    const status = baseStatus({
      desiredCount: 1,
      skills: [
        skillStatus({
          entryId: 'skill_a',
          name: 'frontend-design',
          state: 'modified',
          currentHash: 'sha256:2'.padEnd(71, '0'),
        }),
      ],
      summary: { ...baseSummary, modified: 1 },
    });
    const output = renderStatus(status);
    expect(output).toContain('Changes not added');
    expect(output).toContain('~ frontend-design');
  });

  it('surfaces a missing tracked Skill by name with guidance to use remove', () => {
    const status = baseStatus({
      desiredCount: 1,
      skills: [
        skillStatus({
          entryId: 'skill_a',
          name: 'impeccable',
          state: 'missing',
        }),
      ],
      summary: { ...baseSummary, missing: 1 },
    });
    const output = renderStatus(status);
    expect(output).toContain('! impeccable');
    expect(output).toMatch(/tracked in main, missing on disk/);
    expect(output).toContain('stak remove');
  });

  it('reports Skills not installed on this machine as a count with `stak run`, never as missing', () => {
    const status = baseStatus({
      desiredCount: 2,
      skills: [
        skillStatus({
          entryId: 'skill_a',
          name: 'alpha',
          state: 'not-installed',
        }),
        skillStatus({
          entryId: 'skill_b',
          name: 'beta',
          state: 'not-installed',
        }),
      ],
      summary: { ...baseSummary, notInstalled: 2 },
    });
    const output = renderStatus(status);
    expect(output).toContain('Nothing to add. 2 skills tracked.');
    expect(output).toContain(
      '2 skills in main not installed here yet. Run `stak run <agent>` (e.g. `stak run codex`) to set them up.',
    );
    expect(output).not.toContain('alpha');
    expect(output).not.toContain('missing on disk');
    expect(output).not.toContain('stak remove');
  });

  it('keeps the remove hint for genuinely missing Skills alongside not-installed ones', () => {
    const status = baseStatus({
      desiredCount: 2,
      skills: [
        skillStatus({ entryId: 'skill_a', name: 'alpha', state: 'missing' }),
        skillStatus({
          entryId: 'skill_b',
          name: 'beta',
          state: 'not-installed',
        }),
      ],
      summary: { ...baseSummary, missing: 1, notInstalled: 1 },
    });
    const output = renderStatus(status);
    expect(output).toContain('! alpha  (tracked in main, missing on disk)');
    expect(output).not.toContain('! beta');
    expect(output).toContain('stak remove <skill>');
    expect(output).toContain(
      '1 skill in main not installed here yet. Run `stak run <agent>` (e.g. `stak run codex`) to set it up.',
    );
  });

  it('never claims a clean tree when untracked Skills are present', () => {
    const status = baseStatus({
      untracked: [
        {
          name: 'x',
          contentHash: 'sha256:3'.padEnd(71, '0'),
          source: { type: 'local' },
          locations: [],
        },
      ],
      summary: { ...baseSummary, untracked: 1 },
    });
    const output = renderStatus(status);
    expect(output).not.toContain('Nothing to add');
  });
});

describe('renderDiff (default, non-verbose)', () => {
  const baseDiff = (
    overrides: Partial<EnvironmentDiff> = {},
  ): EnvironmentDiff => ({
    ...baseStatus(),
    entries: [],
    ...overrides,
  });

  it('reports no changes only when untracked is also empty', () => {
    const diff = baseDiff();
    expect(renderDiff(diff)).toContain('No changes.');
  });

  it('includes untracked Skills in the change count and listing — same regression as status', () => {
    const diff = baseDiff({
      untracked: [
        {
          name: 'new-skill',
          contentHash: 'sha256:4'.padEnd(71, '0'),
          source: { type: 'local' },
          locations: [],
        },
      ],
      summary: { ...baseSummary, untracked: 1 },
    });
    const output = renderDiff(diff);
    expect(output).not.toContain('No changes.');
    expect(output).toContain('Untracked');
    expect(output).toContain('new-skill');
  });
});
