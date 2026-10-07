import { CloudServiceError, type CloudService } from '@stack/cloud-server';
import type { SkillDetail, SkillVersionHistoryEntry } from '@stack/spec';

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

export type SkillDetailReviewArtifactView = {
  reviewArtifactId: string;
  candidateRevision: string;
  files: {
    relativePath: string;
    kind: 'added' | 'modified' | 'removed';
    binary: boolean;
    beforeText?: string;
    afterText?: string;
    beforeSize?: number;
    afterSize?: number;
  }[];
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
      viewing: {
        machineId: string;
        name: string;
        statusLabel: string;
        dot: string;
      };
      machines: MachineOption[];
      statusText: string;
      sourceCheckState: SkillDetail['sourceCheckState'];
      checkedAt: string | null;
      candidateRevision?: string;
      reviewArtifactId?: string;
      sourceCheckNote?: string;
      // Present only when a real update was found but Cloud holds no reviewable artifact for
      // it — a REVIEW CAPABILITY fact, distinct from statusText's SOURCE fact.
      reviewNote?: string;
      sourceLabel: string;
      trackedRef?: string;
      approvedVersionShort: string;
      installedHere: string;
      installedHereAt: string | null;
      capabilitiesText: string;
      capabilityList: {
        label: string;
        value: 'declared-true' | 'declared-false';
      }[];
      history: HistoryRow[];
      reviewArtifact: SkillDetailReviewArtifactView | null;
      exceedsReviewBounds: boolean;
      paused: boolean;
    };

/** Shared with skills-data.ts's deriveRow — same note text for the same non-actionable
 *  sourceCheckState values (contract §2/§3). */
const sourceCheckNote = (
  state: SkillDetail['sourceCheckState'],
): string | undefined => {
  switch (state) {
    case 'not-checked':
      return "Updates haven't been checked yet.";
    case 'cannot-check':
      return "Can't check for updates from this source.";
    case 'check-failed':
      return 'Check failed.';
    default:
      return undefined;
  }
};

/** Shared with skills-data.ts's reviewNote — secondary, non-badge explanation for a found
 *  update that Cloud holds no reviewable artifact for. */
const reviewNote = (
  reason: SkillDetail['reviewUnavailableReason'],
): string | undefined =>
  reason === 'exceeds-review-bounds'
    ? 'This update is too large to review in STAK Cloud.'
    : undefined;

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
    .map(([k, v]) => ({
      label: labels[k] ?? k,
      value: v ? 'declared-true' : 'declared-false',
    }));
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
  if (!viewingId)
    return { kind: 'choose-machine', machines: options, anyCheckedIn };

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
    viewingCheckedIn &&
    !!install &&
    install.installedVersion === skill.approvedVersion;

  // Status derivation mirrors apps/web/app/skills/skills-data.ts's deriveRow exactly: paused
  // overrides everything, then update-available, then a three-way installed-state check on the
  // viewing machine (never checked in / checked in with no install / checked in with a mismatched
  // install) before falling through to Ready. None of the three neutral cases is ever "Ready".
  let statusText: string;
  if (skill.paused) statusText = 'Paused';
  else if (skill.sourceCheckState === 'update-available')
    statusText = 'Update available';
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
    sourceCheckState: skill.sourceCheckState,
    checkedAt: skill.checkedAt,
    ...(skill.candidateRevision
      ? { candidateRevision: skill.candidateRevision }
      : {}),
    ...(skill.reviewArtifactId
      ? { reviewArtifactId: skill.reviewArtifactId }
      : {}),
    ...(sourceCheckNote(skill.sourceCheckState)
      ? { sourceCheckNote: sourceCheckNote(skill.sourceCheckState) }
      : {}),
    ...(reviewNote(skill.reviewUnavailableReason)
      ? { reviewNote: reviewNote(skill.reviewUnavailableReason) }
      : {}),
    sourceLabel:
      skill.source.label ??
      (skill.source.kind === 'local' ? 'Local' : skill.source.kind),
    ...(skill.source.trackedRef ? { trackedRef: skill.source.trackedRef } : {}),
    approvedVersionShort: shortHash(skill.approvedVersion),
    installedHere: install
      ? install.installedVersion
        ? shortHash(install.installedVersion)
        : 'Not installed here'
      : 'Not reported here',
    installedHereAt: viewingCheckedIn ? viewing.lastCheckinAt : null,
    capabilitiesText: skill.capability.declared
      ? 'Declared'
      : 'Capabilities not declared',
    capabilityList: capabilityList(skill.capability),
    history,
    reviewArtifact: skill.reviewArtifact
      ? {
          reviewArtifactId: skill.reviewArtifact.reviewArtifactId,
          candidateRevision: skill.reviewArtifact.candidateRevision,
          files: skill.reviewArtifact.files.map((f) => ({
            relativePath: f.relativePath,
            kind: f.kind,
            binary: f.binary,
            ...(f.beforeText !== undefined ? { beforeText: f.beforeText } : {}),
            ...(f.afterText !== undefined ? { afterText: f.afterText } : {}),
            ...(f.before !== undefined
              ? { beforeSize: f.before.byteSize }
              : {}),
            ...(f.after !== undefined ? { afterSize: f.after.byteSize } : {}),
          })),
        }
      : null,
    // Bounds-exceeded: an EXPLICIT review-capability fact from Cloud (contract §5a), not an
    // inference from artifact absence — a source check can be mid-flight/stale in ways that
    // also leave reviewArtifact null without meaning "exceeds bounds". Approve must stay
    // disabled rather than silently unavailable.
    exceedsReviewBounds:
      skill.reviewUnavailableReason === 'exceeds-review-bounds',
    paused: skill.paused,
  };
};
