import { describe, expect, it } from 'vitest';
import type { MachineSummary, MachinesReadModel, SkillSummary, SkillsReadModel } from '@stack/spec';

import { loadSkillsList, deriveRow, filterRows, type SkillsService } from './skills-data.js';

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
  source: { kind: 'git', checkable: true, label: 'github.com/oss/test-first' },
  capability: { declared: false },
  sourceCheckState: 'no-update',
  checkedAt: new Date().toISOString(),
  installs: [{ machineId: A1, installedVersion: 'sha256:' + 'a'.repeat(64) }],
  ...over,
});

const service = (
  skills: SkillSummary[],
  machines: MachineSummary[] = [machine()],
): SkillsService => ({
  getMachinesReadModel: async () => ({ machines } as MachinesReadModel),
  getSkillsReadModel: async () =>
    ({ environmentExists: true, skills } as SkillsReadModel),
});

describe('deriveRow', () => {
  it('is ready when not paused, no update, installed matches approved', () => {
    const row = deriveRow(skill(), A1, true);
    expect(row.primaryStatus).toBe('ready');
    expect(row.dot).toBe('ready');
    expect(row.statusText).toBe('Ready');
  });
  it('is paused regardless of update availability', () => {
    const row = deriveRow(
      skill({ paused: true, sourceCheckState: 'update-available', candidateRevision: 'rev1' }),
      A1,
      true,
    );
    expect(row.statusText).toBe('Paused');
  });
  it('is update-available when not paused and source differs', () => {
    const row = deriveRow(
      skill({ sourceCheckState: 'update-available', candidateRevision: 'rev1' }),
      A1,
      true,
    );
    expect(row.statusText).toBe('Update available');
  });
  it('never claims Ready when the viewing machine has not reported', () => {
    const row = deriveRow(skill(), A1, false);
    expect(row.statusText).not.toBe('Ready');
    expect(row.dot).toBe('neutral');
    expect(row.statusText).toMatch(/not reported|hasn.t reported/i);
  });
  it('never claims Ready when installed differs from approved', () => {
    const row = deriveRow(
      skill({ installs: [{ machineId: A1, installedVersion: 'sha256:' + 'b'.repeat(64) }] }),
      A1,
      true,
    );
    expect(row.statusText).not.toBe('Ready');
  });
  it('distinguishes a different installed version from no install record at all', () => {
    const differentVersion = deriveRow(
      skill({ installs: [{ machineId: A1, installedVersion: 'sha256:' + 'b'.repeat(64) }] }),
      A1,
      true,
    );
    const neverInstalled = deriveRow(skill({ installs: [] }), A1, true);

    expect(differentVersion.statusText).toBe('Different version here');
    expect(neverInstalled.statusText).toBe('Not installed here');
    expect(differentVersion.statusText).not.toBe(neverInstalled.statusText);
    expect(differentVersion.statusText).not.toBe('Ready');
    expect(neverInstalled.statusText).not.toBe('Ready');
    expect(differentVersion.dot).toBe('neutral');
    expect(neverInstalled.dot).toBe('neutral');
  });
  it('shows a cannot-check note without changing primary status', () => {
    const row = deriveRow(
      skill({ source: { kind: 'local', checkable: false }, sourceCheckState: 'cannot-check' }),
      A1,
      true,
    );
    expect(row.statusText).toBe('Ready');
    expect(row.sourceCheckNote).toBe("Can't check for updates from this source.");
  });
  it('keeps the Update available badge and adds a secondary note when the review is oversized', () => {
    const row = deriveRow(
      skill({
        sourceCheckState: 'update-available',
        candidateRevision: 'rev123',
        reviewUnavailableReason: 'exceeds-review-bounds',
      }),
      A1,
      true,
    );
    expect(row.primaryStatus).toBe('update-available');
    expect(row.statusText).toBe('Update available');
    expect(row.dot).toBe('attention');
    expect(row.reviewNote).toBe(
      'This update is too large to review in STAK Cloud.',
    );
  });
  it('shows a not-checked note without blocking Ready', () => {
    const row = deriveRow(skill({ sourceCheckState: 'not-checked' }), A1, true);
    expect(row.statusText).toBe('Ready');
    expect(row.sourceCheckNote).toBe("Updates haven't been checked yet.");
  });
  it('shows a distinct check-failed note', () => {
    const row = deriveRow(skill({ sourceCheckState: 'check-failed' }), A1, true);
    expect(row.statusText).toBe('Ready');
    expect(row.sourceCheckNote).toBe('Check failed.');
  });
  it('has no note when there is no update and the check succeeded', () => {
    const row = deriveRow(skill({ sourceCheckState: 'no-update' }), A1, true);
    expect(row.sourceCheckNote).toBeUndefined();
  });
});

describe('filterRows', () => {
  const rows = [
    deriveRow(skill({ skillId: 'skill_a', name: 'a' }), A1, true),
    deriveRow(skill({ skillId: 'skill_b', name: 'b', paused: true }), A1, true),
    deriveRow(
      skill({ skillId: 'skill_c', name: 'c', sourceCheckState: 'update-available', candidateRevision: 'rev1' }),
      A1,
      true,
    ),
  ];
  it('all returns every row', () => {
    expect(filterRows(rows, 'all', '')).toHaveLength(3);
  });
  it('filters by status', () => {
    expect(filterRows(rows, 'paused', '').map((r) => r.skillId)).toEqual(['skill_b']);
    expect(filterRows(rows, 'update-available', '').map((r) => r.skillId)).toEqual(['skill_c']);
  });
  it('searches by name, case-insensitive', () => {
    expect(filterRows(rows, 'all', 'A').map((r) => r.skillId)).toEqual(['skill_a']);
  });
});

describe('loadSkillsList', () => {
  it('reports no-machines when the account has none', async () => {
    const view = await loadSkillsList(service([], []), USER, undefined);
    expect(view.kind).toBe('no-machines');
  });
  it('excludes revoked machines from selection and counts', async () => {
    const view = await loadSkillsList(
      service([skill()], [machine(), machine({ machineId: B2, revoked: true })]),
      USER,
      undefined,
    );
    expect(view.kind).toBe('ready');
  });
  it('requires a choice with two active machines and no ?machine=', async () => {
    const view = await loadSkillsList(
      service([skill()], [machine(), machine({ machineId: B2, name: 'Studio' })]),
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
    expect(view.rows.map((r) => r.skillId)).toEqual(['skill_dup0001', 'skill_dup0002']);
  });
  it('reports a truthful no-skills state distinct from a filtered empty state', async () => {
    const view = await loadSkillsList(service([]), USER, undefined);
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.rows).toHaveLength(0);
  });
});
