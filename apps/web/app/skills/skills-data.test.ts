import { describe, expect, it } from 'vitest';
import type {
  MachineSummary,
  MachinesReadModel,
  SkillSummary,
  SkillsReadModel,
} from '@stack/spec';

import {
  loadSkillsList,
  deriveRow,
  filterRows,
  type SkillsService,
} from './skills-data.js';

const USER = { id: 'user-1' };
const A1 = '00000000-0000-4000-8000-0000000000a1';
const B2 = '00000000-0000-4000-8000-0000000000b2';

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: A1,
  name: 'DELL',
  platform: 'win32',
  arch: 'x64',
  agentsDetected: ['Claude Code'],
  firstSeenAt: new Date().toISOString(),
  lastCheckinAt: new Date().toISOString(),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 3,
  ...over,
});

const skill = (over: Partial<SkillSummary> = {}): SkillSummary => ({
  skillId: 'skill_test0001',
  name: 'test-first',
  approvedVersion: 'sha256:' + 'a'.repeat(64),
  paused: false,
  source: {
    kind: 'git',
    checkable: true,
    host: 'github.com',
    ownerRepo: 'oss/test-first',
  },
  capability: { declared: false },
  sourceCheckState: 'no-update',
  checkedAt: new Date().toISOString(),
  installs: [{ machineId: A1, installedVersion: 'sha256:' + 'a'.repeat(64) }],
  ...over,
});

/** The `allSkills` list deriveRow needs for its CLI-selector ambiguity check — tests that
 *  don't care about `cliSelector` just need the row's own identity present so the default
 *  (unique-name) path is exercised deterministically. */
const allOf = (
  ...skills: { skillId: string; name: string }[]
): { skillId: string; name: string }[] => skills;

const service = (
  skills: SkillSummary[],
  machines: MachineSummary[] = [machine()],
): SkillsService => ({
  getMachinesReadModel: async () => ({ machines }) as MachinesReadModel,
  getSkillsReadModel: async () =>
    ({ environmentExists: true, skills }) as SkillsReadModel,
});

describe('deriveRow', () => {
  it('is ready when not paused, no update, installed matches approved', () => {
    const s = skill();
    const row = deriveRow(s, A1, true, allOf(s));
    expect(row.primaryStatus).toBe('ready');
    expect(row.dot).toBe('ready');
    expect(row.statusText).toBe('Ready');
    expect(row.reconciliationLabel).toBe('Matches approved');
  });
  it('is paused regardless of update availability', () => {
    const s = skill({
      paused: true,
      sourceCheckState: 'update-available',
      candidateRevision: 'rev1',
    });
    const row = deriveRow(s, A1, true, allOf(s));
    expect(row.statusText).toBe('Paused');
  });
  it('is update-available when not paused and source differs', () => {
    const s = skill({
      sourceCheckState: 'update-available',
      candidateRevision: 'rev1',
    });
    const row = deriveRow(s, A1, true, allOf(s));
    expect(row.statusText).toBe('Update available');
  });
  it('never claims Ready when the viewing machine has not reported', () => {
    const s = skill();
    const row = deriveRow(s, A1, false, allOf(s));
    expect(row.statusText).not.toBe('Ready');
    expect(row.dot).toBe('neutral');
    expect(row.reconciliationState).toBe('not-reported');
    expect(row.reconciliationLabel).toBe('Not reported');
  });
  it('never claims Ready when installed differs from approved', () => {
    const s = skill({
      installs: [
        { machineId: A1, installedVersion: 'sha256:' + 'b'.repeat(64) },
      ],
    });
    const row = deriveRow(s, A1, true, allOf(s));
    expect(row.statusText).not.toBe('Ready');
    expect(row.reconciliationState).toBe('wrong-version');
  });
  it('distinguishes a wrong version, an explicit not-installed report, and no report at all', () => {
    const wrongVersion = skill({
      installs: [
        { machineId: A1, installedVersion: 'sha256:' + 'b'.repeat(64) },
      ],
    });
    const explicitlyNotInstalled = skill({
      installs: [{ machineId: A1, installedVersion: null }],
    });
    const neverReportedSkill = skill({ installs: [] });
    const differentVersion = deriveRow(
      wrongVersion,
      A1,
      true,
      allOf(wrongVersion),
    );
    const notInstalled = deriveRow(
      explicitlyNotInstalled,
      A1,
      true,
      allOf(explicitlyNotInstalled),
    );
    const neverReported = deriveRow(
      neverReportedSkill,
      A1,
      true,
      allOf(neverReportedSkill),
    );

    expect(differentVersion.reconciliationLabel).toBe(
      'Approved version not installed',
    );
    expect(notInstalled.reconciliationLabel).toBe('Not installed');
    expect(neverReported.reconciliationLabel).toBe('Not reported');
    const states = new Set([
      differentVersion.reconciliationState,
      notInstalled.reconciliationState,
      neverReported.reconciliationState,
    ]);
    expect(states.size).toBe(3);
    for (const row of [differentVersion, notInstalled, neverReported]) {
      expect(row.statusText).not.toBe('Ready');
      expect(row.dot).toBe('neutral');
    }
  });
  it('shows a cannot-check note without changing primary status', () => {
    const s = skill({
      source: { kind: 'local', checkable: false },
      sourceCheckState: 'cannot-check',
    });
    const row = deriveRow(s, A1, true, allOf(s));
    expect(row.statusText).toBe('Ready');
    expect(row.sourceCheckNote).toBe(
      "Can't check for updates from this source.",
    );
    expect(row.sourcePrimary).toBe('Local source');
  });
  it('keeps the Update available badge and adds a secondary note when the review is oversized', () => {
    const s = skill({
      sourceCheckState: 'update-available',
      candidateRevision: 'rev123',
      reviewUnavailableReason: 'exceeds-review-bounds',
    });
    const row = deriveRow(s, A1, true, allOf(s));
    expect(row.primaryStatus).toBe('update-available');
    expect(row.statusText).toBe('Update available');
    expect(row.dot).toBe('attention');
    expect(row.reviewNote).toBe(
      'This update is too large to review in STAK Cloud.',
    );
  });
  it('shows a not-checked note without blocking Ready', () => {
    const s = skill({ sourceCheckState: 'not-checked' });
    const row = deriveRow(s, A1, true, allOf(s));
    expect(row.statusText).toBe('Ready');
    expect(row.sourceCheckNote).toBe("Updates haven't been checked yet.");
  });
  it('shows a distinct check-failed note', () => {
    const s = skill({ sourceCheckState: 'check-failed' });
    const row = deriveRow(s, A1, true, allOf(s));
    expect(row.statusText).toBe('Ready');
    expect(row.sourceCheckNote).toBe('Check failed.');
  });
  it('has no note when there is no update and the check succeeded', () => {
    const s = skill({ sourceCheckState: 'no-update' });
    const row = deriveRow(s, A1, true, allOf(s));
    expect(row.sourceCheckNote).toBeUndefined();
  });
  it('Ready and cannot-check coexist — machine reconciliation and source checkability are independent axes', () => {
    const s = skill({
      source: { kind: 'local', checkable: false },
      sourceCheckState: 'cannot-check',
      cannotCheckReason: 'local',
    });
    const row = deriveRow(s, A1, true, allOf(s));
    expect(row.statusText).toBe('Ready');
    expect(row.dot).toBe('ready');
    expect(row.sourceCheckNote).toBe(
      "Can't check for updates from this source.",
    );
  });
  it('prefers the display name as the CLI selector when unique across the viewer’s Skills', () => {
    const s = skill({ skillId: 'skill_unique1', name: 'unique-name' });
    const row = deriveRow(s, A1, true, allOf(s));
    expect(row.cliSelector).toBe('unique-name');
  });
  it('falls back to the stable entryId when two Skills share a display name', () => {
    const a = skill({ skillId: 'skill_dup0001', name: 'dup' });
    const b = skill({ skillId: 'skill_dup0002', name: 'dup' });
    const row = deriveRow(a, A1, true, allOf(a, b));
    expect(row.cliSelector).toBe('skill_dup0001');
  });
});

describe('filterRows', () => {
  const a = skill({ skillId: 'skill_a', name: 'a' });
  const b = skill({ skillId: 'skill_b', name: 'b', paused: true });
  const c = skill({
    skillId: 'skill_c',
    name: 'c',
    sourceCheckState: 'update-available',
    candidateRevision: 'rev1',
  });
  const all = allOf(a, b, c);
  const rows = [
    deriveRow(a, A1, true, all),
    deriveRow(b, A1, true, all),
    deriveRow(c, A1, true, all),
  ];
  it('all returns every row', () => {
    expect(filterRows(rows, 'all', '')).toHaveLength(3);
  });
  it('filters by status', () => {
    expect(filterRows(rows, 'paused', '').map((r) => r.skillId)).toEqual([
      'skill_b',
    ]);
    expect(
      filterRows(rows, 'update-available', '').map((r) => r.skillId),
    ).toEqual(['skill_c']);
  });
  it('searches by name, case-insensitive', () => {
    expect(filterRows(rows, 'all', 'A').map((r) => r.skillId)).toEqual([
      'skill_a',
    ]);
  });
});

describe('loadSkillsList', () => {
  it('reports no-machines when the account has none', async () => {
    const view = await loadSkillsList(service([], []), USER, undefined);
    expect(view.kind).toBe('no-machines');
  });
  it('excludes revoked machines from selection and counts', async () => {
    const view = await loadSkillsList(
      service(
        [skill()],
        [machine(), machine({ machineId: B2, revoked: true })],
      ),
      USER,
      undefined,
    );
    expect(view.kind).toBe('ready');
  });
  it('requires a choice with two active machines and no ?machine=', async () => {
    const view = await loadSkillsList(
      service(
        [skill()],
        [machine(), machine({ machineId: B2, name: 'Studio' })],
      ),
      USER,
      undefined,
    );
    expect(view.kind).toBe('choose-machine');
  });
  it('keeps two Skills with the same display name separately addressable', async () => {
    const view = await loadSkillsList(
      service([
        skill({ skillId: 'skill_dup0001', name: 'review' }),
        skill({ skillId: 'skill_dup0002', name: 'review' }),
      ]),
      USER,
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.rows.map((r) => r.skillId)).toEqual([
      'skill_dup0001',
      'skill_dup0002',
    ]);
    // Ambiguous names fall back to the stable entryId for the CLI selector.
    expect(view.rows.map((r) => r.cliSelector)).toEqual([
      'skill_dup0001',
      'skill_dup0002',
    ]);
  });
  it('reports a truthful no-skills state distinct from a filtered empty state', async () => {
    const view = await loadSkillsList(service([]), USER, undefined);
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.rows).toHaveLength(0);
  });
  it('the page status dot is green only when every Skill is genuinely Ready', async () => {
    const view = await loadSkillsList(service([skill()]), USER, undefined);
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.statusDot).toBe('ready');
  });
  it('the page status dot is amber when an update is available, never an unexplained neutral dot', async () => {
    const view = await loadSkillsList(
      service([
        skill({
          sourceCheckState: 'update-available',
          candidateRevision: 'rev1',
        }),
      ]),
      USER,
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.statusDot).toBe('attention');
  });
  it('surfaces a truthful source-health sentence when every Skill is a cannot-check Local source', async () => {
    const view = await loadSkillsList(
      service([
        skill({
          source: { kind: 'local', checkable: false },
          sourceCheckState: 'cannot-check',
          cannotCheckReason: 'local',
        }),
      ]),
      USER,
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.sourceHealthSentence).toBe(
      "1 Skill can't be checked for upstream updates.",
    );
  });
});
