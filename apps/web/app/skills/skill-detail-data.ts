import { CloudServiceError, type CloudService } from '@stack/cloud-server';
import type {
  SkillDetail,
  SkillShareStatus,
  SkillVersionHistoryEntry,
} from '@stack/spec';

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
import {
  cliSkillSelector,
  machineReconciliation,
  sourceCheckNote,
  sourcePresentation,
  type MachineReconciliationState,
} from '../../lib/skill-presentation.js';
import type { WebUser } from '../../lib/session.js';
import { webAuth } from '../../lib/web-auth.js';

export type SkillDetailService = Pick<
  CloudService,
  | 'getMachinesReadModel'
  | 'getSkillsReadModel'
  | 'getSkillDetail'
  | 'getSkillShareStatus'
>;
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
      statusDot: 'ready' | 'attention' | 'neutral';
      sourceCheckState: SkillDetail['sourceCheckState'];
      checkedAt: string | null;
      candidateRevision?: string;
      reviewArtifactId?: string;
      sourceCheckNote?: string;
      // Present only when a real update was found but Cloud holds no reviewable artifact for
      // it — a REVIEW CAPABILITY fact, distinct from statusText's SOURCE fact.
      reviewNote?: string;
      sourcePrimary: string;
      sourceSecondary?: string;
      sourceCheckable: boolean;
      approvedVersionShort: string;
      /** APPROVED IN STAK fact strip: a real STAK approval-history ordinal ("Version N"),
       *  never a fabricated semver. */
      approvedVersionOrdinal: number;
      approvedAt: string | null;
      reconciliationState: MachineReconciliationState;
      reconciliationLabel: string;
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
      /** The CLI selector a human should type — display name when unique, stable entryId when
       *  ambiguous (§18); shared with the Skills list so the two can never disagree. */
      cliSelector: string;
      /** Whether the reconciliation CommandDock should render at all (§17): only when there is
       *  a real local action to take. A Ready, matches-approved, already-checked Skill shows
       *  no dock. */
      commandDockVisible: boolean;
      /** Present only when commandDockVisible — 'update' to reconcile installed state,
       *  'check' when the source is checkable but has never been checked. */
      commandDockKind?: 'update' | 'check';
      technical: {
        entryId: string;
        approvedContentHash: string;
        installedContentHash: string | null;
        candidateRevision?: string;
        trackedRef?: string;
      };
      share: SkillShareStatus;
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
  const options = ordered.map((m) => machineOption(m, active));
  const anyCheckedIn = active.some(checkedIn);

  const viewingId = resolveViewingMachineId(active, requestedMachine);
  if (!viewingId)
    return { kind: 'choose-machine', machines: options, anyCheckedIn };

  let skill: SkillDetail;
  let allSkills: { skillId: string; name: string }[];
  let share: SkillShareStatus;
  try {
    const [detail, skillsModel, shareStatus] = await Promise.all([
      service.getSkillDetail(auth, skillId),
      service.getSkillsReadModel(auth),
      service.getSkillShareStatus(auth, skillId),
    ]);
    skill = detail;
    allSkills = skillsModel.skills.map((s) => ({
      skillId: s.skillId,
      name: s.name,
    }));
    share = shareStatus.share;
  } catch (error) {
    if (error instanceof CloudServiceError && error.code === 'skill-not-found')
      return { kind: 'not-found' };
    return { kind: 'error' };
  }

  const viewing = active.find((m) => m.machineId === viewingId)!;
  const viewingName = displayName(viewing, active);
  const viewingCheckedIn = checkedIn(viewing);
  const install = skill.installs.find((i) => i.machineId === viewingId);
  const reconciliation = machineReconciliation(
    install,
    skill.approvedVersion,
    viewingCheckedIn,
  );

  // Status derivation mirrors apps/web/app/skills/skills-data.ts's deriveRow exactly: paused
  // overrides everything, then update-available, then machine reconciliation — none of the
  // non-matching reconciliation states is ever "Ready".
  let statusText: string;
  let statusDot: 'ready' | 'attention' | 'neutral';
  if (skill.paused) {
    statusText = 'Paused';
    statusDot = 'neutral';
  } else if (skill.sourceCheckState === 'update-available') {
    statusText = 'Update available';
    statusDot = 'attention';
  } else if (reconciliation.state !== 'matches-approved') {
    statusText = 'Not ready';
    statusDot = 'neutral';
  } else {
    statusText = 'Ready';
    statusDot = 'ready';
  }

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
  const currentHistory = history.find((h) => h.current) ?? null;

  const source = sourcePresentation(skill.source);
  const cliSelector = cliSkillSelector(skill.skillId, skill.name, allSkills);

  const commandDockKind: 'update' | 'check' | undefined = skill.paused
    ? undefined
    : reconciliation.state !== 'matches-approved'
      ? 'update'
      : skill.source.checkable && skill.sourceCheckState === 'not-checked'
        ? 'check'
        : undefined;

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
    statusDot,
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
    ...(skill.reviewUnavailableReason === 'exceeds-review-bounds'
      ? { reviewNote: 'This update is too large to review in STAK Cloud.' }
      : {}),
    sourcePrimary: source.primary,
    ...(source.secondary ? { sourceSecondary: source.secondary } : {}),
    sourceCheckable: skill.source.checkable,
    approvedVersionShort: shortHash(skill.approvedVersion),
    approvedVersionOrdinal: currentHistory?.environmentVersionNumber ?? 1,
    approvedAt: currentHistory?.approvedAt ?? null,
    reconciliationState: reconciliation.state,
    reconciliationLabel: reconciliation.label,
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
    cliSelector,
    commandDockVisible: commandDockKind !== undefined,
    ...(commandDockKind ? { commandDockKind } : {}),
    technical: {
      entryId: skill.skillId,
      approvedContentHash: skill.approvedVersion,
      installedContentHash: install?.installedVersion ?? null,
      ...(skill.candidateRevision
        ? { candidateRevision: skill.candidateRevision }
        : {}),
      ...(skill.source.trackedRef
        ? { trackedRef: skill.source.trackedRef }
        : {}),
    },
    share,
  };
};
