import type { CloudService } from '@stack/cloud-server';

import {
  machineOption,
  resolveViewingMachineId,
  sortMachinesForSelection,
  statusLabel,
  machineDot,
  displayName,
  type MachineOption,
} from './machine-context.js';
import { webAuth } from './web-auth.js';

export type SidebarMachineContext = {
  machines: MachineOption[];
  viewing: {
    machineId: string;
    name: string;
    statusLabel: string;
    dot: string;
  } | null;
  activeCount: number;
};

/**
 * For pages whose own content is NOT machine-scoped (named STAKs: a STAK's composition is
 * account-level, never tied to one machine's check-in state) but whose SIDEBAR still needs
 * a viewing machine to show machine-specific badges and offer the switcher. Degrades
 * gracefully — blank badges, empty switcher — rather than gating the page's real content
 * behind machine selection the way genuinely machine-scoped pages correctly do.
 */
export const resolveSidebarMachineContext = async (
  service: Pick<CloudService, 'getMachinesReadModel'>,
  userId: string,
  requestedMachine: string | undefined,
): Promise<SidebarMachineContext> => {
  try {
    const active = (
      await service.getMachinesReadModel(webAuth(userId))
    ).machines.filter((m) => !m.revoked);
    const ordered = [...active].sort(sortMachinesForSelection);
    const options = ordered.map((m) => machineOption(m, active));
    const viewingId = resolveViewingMachineId(active, requestedMachine);
    const viewingMachine = viewingId
      ? (active.find((m) => m.machineId === viewingId) ?? null)
      : null;
    return {
      machines: options,
      viewing: viewingMachine
        ? {
            machineId: viewingMachine.machineId,
            name: displayName(viewingMachine, active),
            statusLabel: statusLabel(viewingMachine),
            dot: machineDot(viewingMachine),
          }
        : null,
      activeCount: active.length,
    };
  } catch {
    return { machines: [], viewing: null, activeCount: 0 };
  }
};
