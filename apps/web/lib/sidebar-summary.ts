import type { CloudService } from '@stack/cloud-server';

import type { SidebarCounts } from '../app/overview/overview-data.js';
import type { WebUser } from './session.js';
import { webAuth } from './web-auth.js';

export type SidebarSummaryService = Pick<
  CloudService,
  'getOverview' | 'listUserStacks'
>;

const BLANK_SIDEBAR: SidebarCounts = {
  overview: { n: '', tone: 'neutral' },
  skills: '',
  memory: { n: '', tone: 'neutral' },
  projects: '',
  machines: '',
  staks: '',
};

/**
 * The same 5 badge counts shown in the sidebar on every authenticated route — computed in
 * ONE place so no page duplicates (or, as several did, only partially duplicates) this
 * logic. Every route that renders `AppSidebar` should call this rather than hand-rolling
 * its own subset of counts or a hardcoded placeholder (the actual launch bug: several
 * detail/nested routes rendered a `PLACEHOLDER_SIDEBAR` with every field blank).
 *
 * Machine-specific counts (Memory, and the attention/skills figures `getOverview` returns)
 * are scoped to `viewingMachineId` — the SAME selected-machine id every other part of the
 * page already resolved via `resolveViewingMachineId`, never a second/stale resolution.
 * Falls back to blank-but-never-wrong counts (never a fabricated number) if the viewing
 * machine is unset or any read fails, so the sidebar degrades gracefully rather than
 * breaking the page it sits on.
 */
export const loadSidebarSummary = async (
  service: SidebarSummaryService,
  user: WebUser,
  viewingMachineId: string | null,
  activeMachineCount: number,
): Promise<SidebarCounts> => {
  if (!viewingMachineId)
    return { ...BLANK_SIDEBAR, machines: String(activeMachineCount) };

  const auth = webAuth(user.id);
  try {
    const [overview, stacksModel] = await Promise.all([
      service.getOverview(auth, viewingMachineId),
      service.listUserStacks(auth),
    ]);
    const attentionCount = overview.needsAttention.length;
    return {
      overview:
        attentionCount > 0
          ? { n: String(attentionCount), tone: 'attention' }
          : { n: '', tone: 'neutral' },
      skills: String(overview.skills.total),
      memory: overview.lastBackupAt
        ? { n: 'Backed up', tone: 'ready' }
        : { n: '', tone: 'neutral' },
      projects:
        overview.projects.total > 0 ? String(overview.projects.total) : '',
      machines: String(activeMachineCount),
      staks:
        stacksModel.stacks.length > 0 ? String(stacksModel.stacks.length) : '',
    };
  } catch {
    return { ...BLANK_SIDEBAR, machines: String(activeMachineCount) };
  }
};
