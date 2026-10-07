import { CloudServiceError, type CloudService } from '@stack/cloud-server';
import type { SkillDetail, SkillDiffFile, SkillFile, SkillVersionHistoryEntry } from '@stack/spec';

import {
  machineOption,
  resolveViewingMachineId,
  sortMachinesForSelection,
  statusLabel,
  machineDot,
  displayName,
  checkedIn,
  type MachineOption,
} from '../../lib/machine-context.js';
import type { WebUser } from '../../lib/session.js';

export type SkillDetailService = Pick<
  CloudService,
  'getMachinesReadModel' | 'getSkillDetail'
>;

const webAuth = (userId: string) => ({ userId, tokenId: 'web-session' });
const shortHash = (hash: string) => hash.slice(7, 15);

export type HistoryRow = {
  contentHash: string;
  shortHash: string;
  environmentVersionNumber: number;
  approvedAt: string;
  current: boolean;
};

export type SkillDetailView =
  | { kind: 'error' }
  | { kind: 'no-machines' }
  | { kind: 'choose-machine'; machines: MachineOption[]; anyCheckedIn: boolean }
  | { kind: 'not-found' }
  | {
      kind: 'ready';
      skillId: string;
      name: string;
      description?: string;
      viewing: { machineId: string; name: string; statusLabel: string; dot: string };
      machines: MachineOption[];
      statusText: string;
      updateAvailable: boolean;
      candidateVersion?: string;
      cannotCheckNote: boolean;
      sourceLabel: string;
      trackedRef?: string;
      approvedVersionShort: string;
      installedHere: string;
      installedHereAt: string | null;
      capabilitiesText: string;
      capabilityList: { label: string; value: 'declared-true' | 'declared-false' }[];
      history: HistoryRow[];
      filesAvailable: boolean;
      files: SkillFile[];
      diffAvailable: boolean;
      diffFiles: SkillDiffFile[];
      paused: boolean;
    };

const capabilityList = (
  capability: SkillDetail['capability'],
): { label: string; value: 'declared-true' | 'declared-false' }[] => {
  if (!capability.declared || !capability.capabilities) return [];
  const labels: Record<string, string> = {
    readFiles: 'Read files',
    writeFiles: 'Write files',
    runCommands: 'Run commands',
    network: 'Network',
  };
  return Object.entries(capability.capabilities)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ({ label: labels[k] ?? k, value: v ? 'declared-true' : 'declared-false' }));
};

export const loadSkillDetail = async (
  service: SkillDetailService,
  user: WebUser,
  skillId: string,
  requestedMachine: string | undefined,
): Promise<SkillDetailView> => {
  const auth = webAuth(user.id);
  let machinesModel;
  try {
    machinesModel = await service.getMachinesReadModel(auth);
  } catch {
    return { kind: 'error' };
  }
  const active = machinesModel.machines.filter((m) => !m.revoked);
  if (active.length === 0) return { kind: 'no-machines' };

  const ordered = [...active].sort(sortMachinesForSelection);
  const options = ordered.map(machineOption);
  const anyCheckedIn = active.some(checkedIn);

  const viewingId = resolveViewingMachineId(active, requestedMachine);
  if (!viewingId) return { kind: 'choose-machine', machines: options, anyCheckedIn };

  let skill: SkillDetail;
  try {
    skill = await service.getSkillDetail(auth, skillId);
  } catch (error) {
    if (error instanceof CloudServiceError && error.code === 'skill-not-found')
      return { kind: 'not-found' };
    return { kind: 'error' };
  }

  const viewing = active.find((m) => m.machineId === viewingId)!;
  const viewingName = displayName(viewing);
  const viewingCheckedIn = checkedIn(viewing);
  const install = skill.installs.find((i) => i.machineId === viewingId);
  const installedHereMatches =
    viewingCheckedIn && !!install && install.installedVersion === skill.approvedVersion;

  // Status derivation mirrors apps/web/app/skills/skills-data.ts's deriveRow exactly: paused
  // overrides everything, then update-available, then a three-way installed-state check on the
  // viewing machine (never checked in / checked in with no install / checked in with a mismatched
  // install) before falling through to Ready. None of the three neutral cases is ever "Ready".
  let statusText: string;
  if (skill.paused) statusText = 'Paused';
  else if (skill.updateStatus === 'update-available') statusText = 'Update available';
  else if (!viewingCheckedIn) statusText = 'Not reported here yet';
  else if (!install) statusText = 'Not installed here';
  else if (!installedHereMatches) statusText = 'Different version here';
  else statusText = 'Ready';

  const history: HistoryRow[] = skill.history
    .slice()
    .sort((a, b) => b.environmentVersionNumber - a.environmentVersionNumber)
    .map((h: SkillVersionHistoryEntry) => ({
      contentHash: h.contentHash,
      shortHash: shortHash(h.contentHash),
      environmentVersionNumber: h.environmentVersionNumber,
      approvedAt: h.approvedAt,
      current: h.contentHash === skill.approvedVersion,
    }));

  return {
    kind: 'ready',
    skillId: skill.skillId,
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    viewing: {
      machineId: viewingId,
      name: viewingName,
      statusLabel: statusLabel(viewing),
      dot: machineDot(viewing),
    },
    machines: options,
    statusText,
    updateAvailable: skill.updateStatus === 'update-available',
    ...(skill.candidateVersion ? { candidateVersion: skill.candidateVersion } : {}),
    cannotCheckNote: skill.updateStatus === 'cannot-check',
    sourceLabel: skill.source.label ?? (skill.source.kind === 'local' ? 'Local' : skill.source.kind),
    ...(skill.source.trackedRef ? { trackedRef: skill.source.trackedRef } : {}),
    approvedVersionShort: shortHash(skill.approvedVersion),
    installedHere: install
      ? install.installedVersion
        ? shortHash(install.installedVersion)
        : 'Not installed here'
      : 'Not reported here',
    installedHereAt: viewingCheckedIn ? viewing.lastCheckinAt : null,
    capabilitiesText: skill.capability.declared ? 'Declared' : 'Capabilities not declared',
    capabilityList: capabilityList(skill.capability),
    history,
    filesAvailable: skill.files !== null,
    files: skill.files ?? [],
    diffAvailable: skill.diff !== null,
    diffFiles: skill.diff?.files ?? [],
    paused: skill.paused,
  };
};
