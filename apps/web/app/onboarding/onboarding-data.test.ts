import { describe, expect, it } from 'vitest';

import type { MachineSummary, MemoryReadModel } from '@stack/spec';

import {
  deriveOnboardingChecklist,
  deriveOnboardingMode,
  shouldSkipOnboarding,
} from './onboarding-data.js';

const nowIso = (minsAgo: number) =>
  new Date(Date.now() - minsAgo * 60_000).toISOString();

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: '00000000-0000-4000-8000-0000000000a1',
  name: 'Atlas',
  platform: 'darwin',
  arch: 'arm64',
  agentsDetected: [],
  firstSeenAt: nowIso(10),
  lastCheckinAt: null,
  memoryBackedUp: false,
  revoked: false,
  status: 'never-checked-in',
  updatesWaiting: [],
  projectsPresent: 0,
  ...over,
});

const memory = (over: Partial<MemoryReadModel> = {}): MemoryReadModel => ({
  mode: null,
  latestBackupAt: null,
  backups: [],
  recoveryMethods: [],
  hasRecoveryMethod: false,
  perProject: null,
  ...over,
});

describe('shouldSkipOnboarding', () => {
  it('shows onboarding for a brand-new account with no machines and no backup', () => {
    expect(shouldSkipOnboarding({ machines: [], memory: memory() })).toBe(
      false,
    );
  });

  it('shows onboarding while a machine exists but has never checked in and nothing is backed up', () => {
    expect(
      shouldSkipOnboarding({ machines: [machine()], memory: memory() }),
    ).toBe(false);
  });

  it('skips onboarding once a machine has checked in and a backup exists', () => {
    expect(
      shouldSkipOnboarding({
        machines: [machine({ lastCheckinAt: nowIso(5) })],
        memory: memory({ mode: 'standard', latestBackupAt: nowIso(5) }),
      }),
    ).toBe(true);
  });

  it('never traps an established account even if the only machine was later revoked', () => {
    expect(
      shouldSkipOnboarding({
        machines: [machine({ lastCheckinAt: nowIso(5), revoked: true })],
        memory: memory({ mode: 'standard', latestBackupAt: nowIso(5) }),
      }),
    ).toBe(true);
  });
});

describe('deriveOnboardingMode', () => {
  it('is new-account when there is no Cloud backup yet', () => {
    expect(deriveOnboardingMode({ memory: memory() })).toBe('new-account');
  });

  it('is existing-account-new-machine once a Cloud backup exists', () => {
    expect(
      deriveOnboardingMode({
        memory: memory({ mode: 'protected', latestBackupAt: nowIso(60) }),
      }),
    ).toBe('existing-account-new-machine');
  });
});

describe('deriveOnboardingChecklist', () => {
  it('marks nothing done for a fresh account', () => {
    const steps = deriveOnboardingChecklist({ machines: [], memory: memory() });
    expect(steps.every((s) => !s.done)).toBe(true);
    expect(steps[0]?.key).toBe('approved');
  });

  it('marks approved + agents-found once a machine with agents exists', () => {
    const steps = deriveOnboardingChecklist({
      machines: [machine({ agentsDetected: ['Claude Code'] })],
      memory: memory(),
    });
    expect(steps.find((s) => s.key === 'approved')?.done).toBe(true);
    expect(steps.find((s) => s.key === 'agents-found')?.done).toBe(true);
    expect(steps.find((s) => s.key === 'memory-mode')?.done).toBe(false);
  });

  it('marks memory-mode and first-backup done once a profile and backup exist', () => {
    const steps = deriveOnboardingChecklist({
      machines: [machine()],
      memory: memory({ mode: 'protected', latestBackupAt: nowIso(1) }),
    });
    expect(steps.find((s) => s.key === 'memory-mode')?.done).toBe(true);
    expect(steps.find((s) => s.key === 'first-backup')?.done).toBe(true);
  });

  it('marks the optional second-machine step done only with 2+ active machines', () => {
    const one = deriveOnboardingChecklist({
      machines: [machine()],
      memory: memory(),
    });
    expect(one.find((s) => s.key === 'second-machine')?.done).toBe(false);

    const two = deriveOnboardingChecklist({
      machines: [
        machine(),
        machine({ machineId: '00000000-0000-4000-8000-0000000000a2' }),
      ],
      memory: memory(),
    });
    expect(two.find((s) => s.key === 'second-machine')?.done).toBe(true);
  });

  it('never counts a revoked machine toward approval or agent discovery', () => {
    const steps = deriveOnboardingChecklist({
      machines: [machine({ revoked: true, agentsDetected: ['Claude Code'] })],
      memory: memory(),
    });
    expect(steps.find((s) => s.key === 'approved')?.done).toBe(false);
    expect(steps.find((s) => s.key === 'agents-found')?.done).toBe(false);
  });
});
