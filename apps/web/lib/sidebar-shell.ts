import type { CloudService } from '@stack/cloud-server';

import type { SidebarCounts } from '../app/overview/overview-data.js';
import type { WebUser } from './session.js';
import {
  resolveSidebarMachineContext,
  type SidebarMachineContext,
} from './sidebar-machine-context.js';
import { loadSidebarSummary } from './sidebar-summary.js';

export type SidebarShell = {
  machineContext: SidebarMachineContext;
  sidebarCounts: SidebarCounts;
};

/**
 * Everything `AppSidebar` needs, as one unit a page can start alongside its own reads
 * (`Promise.all`) instead of awaiting it first. Never rejects: both steps degrade to
 * blank-but-honest values on failure. `getMachinesReadModel` is request-`cache()`d, so a
 * page loader resolving machines too doesn't pay for it twice.
 */
export const loadSidebarShell = async (
  service: Pick<
    CloudService,
    'getMachinesReadModel' | 'getOverview' | 'listUserStacks'
  >,
  user: WebUser,
  requestedMachine: string | undefined,
): Promise<SidebarShell> => {
  const machineContext = await resolveSidebarMachineContext(
    service,
    user.id,
    requestedMachine,
  );
  const sidebarCounts = await loadSidebarSummary(
    service,
    user,
    machineContext.viewing?.machineId ?? null,
    machineContext.activeCount,
  );
  return { machineContext, sidebarCounts };
};
