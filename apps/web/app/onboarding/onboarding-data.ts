import type { CloudService } from '@stack/cloud-server';
import type { MachineSummary, MemoryReadModel } from '@stack/spec';

import type { WebUser } from '../../lib/session.js';
import { webAuth } from '../../lib/web-auth.js';

export type OnboardingStepKey =
  | 'approved'
  | 'agents-found'
  | 'memory-mode'
  | 'first-backup'
  | 'second-machine';

export type OnboardingStep = {
  key: OnboardingStepKey;
  label: string;
  detail: string;
  done: boolean;
  optional?: boolean;
};

/**
 * Account is considered established the moment it has both a machine that has
 * ever checked in and a Cloud Memory backup — the two real records the Final
 * Contract's onboarding derivation is built on. Check-in history survives a
 * later revoke (revoking is a current-access decision, not an erasure of past
 * setup), so revoking the only machine never re-traps an otherwise-established
 * account in onboarding — it shows the existing-account-new-machine flow.
 */
export const shouldSkipOnboarding = (input: {
  machines: MachineSummary[];
  memory: MemoryReadModel;
}): boolean => {
  const hasCheckedInMachine = input.machines.some(
    (m) => m.lastCheckinAt !== null,
  );
  return hasCheckedInMachine && input.memory.latestBackupAt !== null;
};

/**
 * Which onboarding narrative to show. A Cloud backup already existing means
 * this is an existing account bringing its STAK to another machine, not a
 * from-zero setup — those two flows are not the same sequence (contract §2).
 */
export const deriveOnboardingMode = (input: {
  memory: MemoryReadModel;
}): 'new-account' | 'existing-account-new-machine' =>
  input.memory.latestBackupAt !== null
    ? 'existing-account-new-machine'
    : 'new-account';

export const deriveOnboardingChecklist = (input: {
  machines: MachineSummary[];
  memory: MemoryReadModel;
}): OnboardingStep[] => {
  const active = input.machines.filter((m) => !m.revoked);
  const approved = active.length > 0;
  const agentsFound = active.some((m) => m.agentsDetected.length > 0);
  const memoryModeChosen = input.memory.mode !== null;
  const firstBackup = input.memory.latestBackupAt !== null;
  const secondMachine = active.length > 1;

  return [
    {
      key: 'approved',
      label: 'Approve this machine',
      detail: 'Run `stak login` and approve it here in your browser.',
      done: approved,
    },
    {
      key: 'agents-found',
      label: 'Find your agents',
      detail: '`stak scan` looks for Claude Code, Codex, and other agents.',
      done: agentsFound,
    },
    {
      key: 'memory-mode',
      label: 'Choose how Memory is kept',
      detail:
        'Standard or Protected, account-wide. Protected is switched on with `stak memory protect`.',
      done: memoryModeChosen,
    },
    {
      key: 'first-backup',
      label: 'First backup',
      detail: 'Run `stak memory backup`. Only what you confirm is backed up.',
      done: firstBackup,
    },
    {
      key: 'second-machine',
      label: 'Add a second machine',
      detail: 'Optional — then your STAK no longer depends on one machine.',
      done: secondMachine,
      optional: true,
    },
  ];
};

export type OnboardingService = Pick<
  CloudService,
  'getMachinesReadModel' | 'getMemoryReadModel'
>;

export type OnboardingView =
  | { kind: 'error' }
  | { kind: 'skip' }
  | {
      kind: 'ready';
      mode: 'new-account' | 'existing-account-new-machine';
      steps: OnboardingStep[];
      machineCount: number;
    };

export const loadOnboardingView = async (
  service: OnboardingService,
  user: WebUser,
): Promise<OnboardingView> => {
  const auth = webAuth(user.id);
  let machinesModel;
  let memory;
  try {
    [machinesModel, memory] = await Promise.all([
      service.getMachinesReadModel(auth),
      service.getMemoryReadModel(auth),
    ]);
  } catch {
    return { kind: 'error' };
  }
  const machines = machinesModel.machines;
  if (shouldSkipOnboarding({ machines, memory })) return { kind: 'skip' };
  return {
    kind: 'ready',
    mode: deriveOnboardingMode({ memory }),
    steps: deriveOnboardingChecklist({ machines, memory }),
    machineCount: machines.filter((m) => !m.revoked).length,
  };
};
