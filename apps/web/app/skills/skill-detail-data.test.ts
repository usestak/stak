import { describe, expect, it } from 'vitest';
import { CloudServiceError } from '@stack/cloud-server';
import type { MachineSummary, MachinesReadModel, SkillDetail } from '@stack/spec';

import { loadSkillDetail, type SkillDetailService } from './skill-detail-data.js';

const USER = { id: 'user-1' };
const A1 = '00000000-0000-4000-8000-0000000000a1';
const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);

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

const detail = (over: Partial<SkillDetail> = {}): SkillDetail => ({
  skillId: 'skill_test0001',
  name: 'test-first',
  approvedVersion: HASH_A,
  paused: false,
  source: { kind: 'git', checkable: true, label: 'github.com/oss/test-first', trackedRef: 'main' },
  capability: { declared: false },
  updateStatus: 'no-update',
  installs: [{ machineId: A1, installedVersion: HASH_A }],
  history: [{ contentHash: HASH_A, environmentVersionNumber: 1, approvedAt: new Date().toISOString() }],
  files: null,
  diff: null,
  ...over,
});

const service = (
  skill: SkillDetail | null,
  machines: MachineSummary[] = [machine()],
): SkillDetailService => ({
  getMachinesReadModel: async () => ({ machines } as MachinesReadModel),
  getSkillDetail: async (_auth, skillId) => {
    if (!skill || skillId !== skill.skillId)
      throw new CloudServiceError('skill-not-found', 404, 'No such Skill.');
    return skill;
  },
});

describe('loadSkillDetail', () => {
  it('fails safely on an invalid/not-owned skill id', async () => {
    const view = await loadSkillDetail(service(detail()), USER, 'skill_other0001', undefined);
    expect(view.kind).toBe('not-found');
  });
  it('renders Ready with matching install', async () => {
    const view = await loadSkillDetail(service(detail()), USER, 'skill_test0001', undefined);
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.statusText).toBe('Ready');
  });
  it('shows an honest unavailable state when files is null', async () => {
    const view = await loadSkillDetail(service(detail({ files: null })), USER, 'skill_test0001', undefined);
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.filesAvailable).toBe(false);
  });
  it('shows an honest unavailable state when diff is null even with an update available', async () => {
    const view = await loadSkillDetail(
      service(detail({ updateStatus: 'update-available', candidateVersion: 'rev123', diff: null })),
      USER,
      'skill_test0001',
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.diffAvailable).toBe(false);
    expect(view.statusText).toBe('Update available');
  });
  it('keeps provenance/history/capabilities visible while paused (§17)', async () => {
    const view = await loadSkillDetail(
      service(detail({ paused: true, updateStatus: 'update-available', candidateVersion: 'rev123' })),
      USER,
      'skill_test0001',
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.statusText).toBe('Paused');
    expect(view.updateAvailable).toBe(true);
    expect(view.sourceLabel).toBe('github.com/oss/test-first');
    expect(view.history).toHaveLength(1);
  });
  it('distinguishes currently-approved from older history entries', async () => {
    const view = await loadSkillDetail(
      service(
        detail({
          history: [
            { contentHash: HASH_B, environmentVersionNumber: 2, approvedAt: new Date().toISOString() },
            { contentHash: HASH_A, environmentVersionNumber: 1, approvedAt: new Date().toISOString() },
          ],
          approvedVersion: HASH_B,
        }),
      ),
      USER,
      'skill_test0001',
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.history[0]?.current).toBe(true);
    expect(view.history[1]?.current).toBe(false);
  });
  it('reports capabilities-not-declared distinctly from declared-false', async () => {
    const notDeclared = await loadSkillDetail(service(detail({ capability: { declared: false } })), USER, 'skill_test0001', undefined);
    const declaredFalse = await loadSkillDetail(
      service(detail({ capability: { declared: true, capabilities: { network: false } } })),
      USER,
      'skill_test0001',
      undefined,
    );
    if (notDeclared.kind !== 'ready' || declaredFalse.kind !== 'ready') throw new Error('expected ready');
    expect(notDeclared.capabilitiesText).toBe('Capabilities not declared');
    expect(declaredFalse.capabilitiesText).not.toBe('Capabilities not declared');
  });
  it('never exposes an absolute or home-relative path in source label', async () => {
    const view = await loadSkillDetail(
      service(detail({ source: { kind: 'local', checkable: false } })),
      USER,
      'skill_test0001',
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.sourceLabel).toBe('Local');
    expect(view.sourceLabel).not.toMatch(/[\\/]Users[\\/]|^~|^\/home\//);
  });
  it('reports "Not reported here yet" when the viewing machine never checked in', async () => {
    const view = await loadSkillDetail(
      service(detail(), [machine({ lastCheckinAt: null, status: 'never-checked-in' })]),
      USER,
      'skill_test0001',
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.statusText).toBe('Not reported here yet');
  });
  it('reports "Not installed here" when the viewing machine checked in but has no install record', async () => {
    const view = await loadSkillDetail(
      service(detail({ installs: [] })),
      USER,
      'skill_test0001',
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.statusText).toBe('Not installed here');
  });
  it('reports "Different version here" when the viewing machine has a mismatched install', async () => {
    const view = await loadSkillDetail(
      service(detail({ installs: [{ machineId: A1, installedVersion: HASH_B }] })),
      USER,
      'skill_test0001',
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.statusText).toBe('Different version here');
  });
});
