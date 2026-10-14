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
  // Routing matrix (P8 correction pass): skip ONLY when a Cloud backup
  // exists AND at least one active (non-revoked) machine has checked in.

  it('row 1: no backup, no machines -> onboarding', () => {
    expect(shouldSkipOnboarding({ machines: [], memory: memory() })).toBe(
      false,
    );
  });

  it('row 2: no backup, active checked-in machine -> onboarding', () => {
    expect(
      shouldSkipOnboarding({
        machines: [machine({ lastCheckinAt: nowIso(5) })],
        memory: memory(),
      }),
    ).toBe(false);
  });

  it('row 3: backup exists, active checked-in machine -> skip (Overview)', () => {
    expect(
      shouldSkipOnboarding({
        machines: [machine({ lastCheckinAt: nowIso(5) })],
        memory: memory({ mode: 'standard', latestBackupAt: nowIso(5) }),
      }),
    ).toBe(true);
  });

  it('row 4: backup exists, zero active machines -> onboarding', () => {
    expect(
      shouldSkipOnboarding({
        machines: [],
        memory: memory({ mode: 'standard', latestBackupAt: nowIso(5) }),
      }),
    ).toBe(false);
  });

  it('row 5: backup exists, only revoked historical machines (even if they checked in) -> onboarding', () => {
    expect(
      shouldSkipOnboarding({
        machines: [machine({ lastCheckinAt: nowIso(5), revoked: true })],
        memory: memory({ mode: 'standard', latestBackupAt: nowIso(5) }),
      }),
    ).toBe(false);
  });

  it('row 6: backup exists, active machine exists but never checked in -> onboarding', () => {
    expect(
      shouldSkipOnboarding({
        machines: [machine({ lastCheckinAt: null, revoked: false })],
        memory: memory({ mode: 'standard', latestBackupAt: nowIso(5) }),
      }),
    ).toBe(false);
  });

  it('row 7: no backup, only revoked historical machines -> onboarding', () => {
    expect(
      shouldSkipOnboarding({
        machines: [machine({ lastCheckinAt: nowIso(5), revoked: true })],
        memory: memory(),
      }),
    ).toBe(false);
  });

  it('mixed fleet: one revoked (checked-in) + one active (checked-in) + backup -> skip', () => {
    expect(
      shouldSkipOnboarding({
        machines: [
          machine({ lastCheckinAt: nowIso(10), revoked: true }),
          machine({
            machineId: '00000000-0000-4000-8000-0000000000a2',
            lastCheckinAt: nowIso(1),
            revoked: false,
          }),
        ],
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

  // Launch-polish command-truth pass: verified from actual CLI command
  // semantics that the correct first-run sequence is login -> scan -> choose
  // Memory mode -> first backup (`stak scan` is local/read-only and has no
  // dependency on being signed in first; it's step 2, never replaced by
  // `stak memory backup`, which was Overview's previous, incorrect claim).
  it('teaches the verified first-run sequence in order: login, scan, memory mode, backup', () => {
    const steps = deriveOnboardingChecklist({
      machines: [],
      memory: memory(),
    });
    expect(steps.map((s) => s.key)).toEqual([
      'approved',
      'agents-found',
      'memory-mode',
      'first-backup',
      'second-machine',
    ]);
    expect(steps[0]!.detail).toContain('stak login');
    expect(steps[1]!.detail).toContain('stak scan');
    expect(steps[2]!.detail).toContain('stak memory protect');
    expect(steps[3]!.detail).toContain('stak memory backup');
  });

  // The second-machine step must not claim adding a machine removes
  // dependency on the first - only that the STAK/Memory come along too.
  it('does not claim a second machine removes dependency on the first', () => {
    const steps = deriveOnboardingChecklist({
      machines: [machine()],
      memory: memory(),
    });
    const detail = steps.find((s) => s.key === 'second-machine')!.detail;
    expect(detail).not.toMatch(/no longer depends/i);
    expect(detail.toLowerCase()).toContain('bring your stak and memory');
  });
});
