import type { CloudService } from '@stack/cloud-server';
import type { MemoryMode } from '@stack/spec';

import type { WebUser } from '../../lib/session.js';
import { webAuth } from '../../lib/web-auth.js';

export type SettingsService = Pick<
  CloudService,
  'getMachinesReadModel' | 'getMemoryReadModel'
>;

export type SettingsView =
  | { kind: 'error' }
  | {
      kind: 'ready';
      mode: MemoryMode | null;
      backedUp: boolean;
      latestBackupAt: string | null;
      hasRecoveryMethod: boolean;
      recoveryMethods: { type: string; label: string }[];
      /** Needs attention (contract §10/§12): Protected with no recovery method.
       *  Standard never needs one, so this is never true for Standard. */
      recoveryNeedsAttention: boolean;
      activeMachineCount: number;
    };

export const loadSettingsView = async (
  service: SettingsService,
  user: WebUser,
): Promise<SettingsView> => {
  const auth = webAuth(user.id);
  try {
    const [machinesModel, memory] = await Promise.all([
      service.getMachinesReadModel(auth),
      service.getMemoryReadModel(auth),
    ]);
    const activeMachineCount = machinesModel.machines.filter(
      (m) => !m.revoked,
    ).length;
    return {
      kind: 'ready',
      mode: memory.mode,
      backedUp: memory.latestBackupAt !== null,
      latestBackupAt: memory.latestBackupAt,
      hasRecoveryMethod: memory.hasRecoveryMethod,
      recoveryMethods: memory.recoveryMethods.map((m) => ({
        type: m.type,
        label: m.label,
      })),
      recoveryNeedsAttention:
        memory.mode === 'protected' && !memory.hasRecoveryMethod,
      activeMachineCount,
    };
  } catch {
    return { kind: 'error' };
  }
};
