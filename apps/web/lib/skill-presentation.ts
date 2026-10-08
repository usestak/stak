import type {
  SkillInstall,
  SkillSourceSummary,
  SourceCheckState,
} from '@stack/spec';

/**
 * Shared Skill presentation logic — the single place the Skills list and detail pages derive
 * source-check copy, machine-reconciliation state, source provenance, and the CLI selector a
 * human should type. Kept here, not duplicated per page, so list and detail cannot drift apart
 * (the exact bug class found in P5 visual-correction review: Local rendering "Updates haven't
 * been checked yet.").
 */

/** Non-actionable sourceCheckState → the secondary, non-badge sentence shown next to source
 *  (contract §2/§3/§5a). 'no-update' and 'update-available' need no note — the primary status
 *  already communicates them. */
export const sourceCheckNote = (
  state: SourceCheckState,
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

/** Known Git hosting providers get a friendly name; anything else shows its (already-safe)
 *  host verbatim — the host itself carries no credentials. */
const PROVIDER_NAMES: Record<string, string> = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'bitbucket.org': 'Bitbucket',
};

export type SourcePresentation = {
  /** The primary "where did this come from?" answer. */
  primary: string;
  /** Secondary explanatory copy — only when it adds real information. */
  secondary?: string;
};

/** Answers "where did this come from?" using only already-sanitized fields (contract §5a +
 *  P5 visual-correction §3/§4). Never touches a raw remote string — `host`/`ownerRepo` are
 *  produced server-side by `@stack/shared`'s `safeGitRemoteDisplay`, the only place allowed to
 *  parse one. */
export const sourcePresentation = (
  source: SkillSourceSummary,
): SourcePresentation => {
  if (source.kind === 'local')
    return {
      primary: 'Local source',
      secondary: 'No upstream repository recorded.',
    };
  if (source.kind === 'git') {
    const provider = source.host
      ? (PROVIDER_NAMES[source.host] ?? source.host)
      : null;
    const primary =
      provider && source.ownerRepo
        ? `${provider} · ${source.ownerRepo}`
        : (provider ?? 'Git source');
    const secondary = source.trackedRef
      ? `tracked ref: ${source.trackedRef}`
      : undefined;
    return secondary ? { primary, secondary } : { primary };
  }
  if (source.kind === 'public-stack') return { primary: 'Public stack' };
  // 'snapshot': a point-in-time capture whose original source isn't tracked (dirty/ambiguous/
  // unknown/non-portable) — distinct from 'local', which never had an upstream at all.
  return {
    primary: 'Unresolved source',
    secondary: "This Skill's original source isn't tracked.",
  };
};

export type MachineReconciliationState =
  'matches-approved' | 'wrong-version' | 'not-installed' | 'not-reported';

export type MachineReconciliation = {
  state: MachineReconciliationState;
  /** Primary, human-readable reconciliation fact. */
  label: string;
};

/** The ON-<MACHINE> column/fact answers one question: does this machine's last check-in match
 *  what STAK approved? (contract §19 + P5 visual-correction §2/§12). Independent of source
 *  checkability — a Skill can be "Matches approved" while its source is "Can't check for
 *  updates from this source" at the same time; these are different axes. */
export const machineReconciliation = (
  install: SkillInstall | undefined,
  approvedVersion: string,
  viewingMachineCheckedIn: boolean,
): MachineReconciliation => {
  if (!viewingMachineCheckedIn || !install)
    return { state: 'not-reported', label: 'Not reported' };
  if (install.installedVersion === null)
    return { state: 'not-installed', label: 'Not installed' };
  if (install.installedVersion === approvedVersion)
    return { state: 'matches-approved', label: 'Matches approved' };
  return { state: 'wrong-version', label: 'Approved version not installed' };
};

/** The CLI selector a human should be shown for `stak skill update`/`stak skill check`
 *  (P5 visual-correction §18): the display name when it is unique across every Skill the
 *  viewer can see (mirroring `resolveSkillSelector`'s own "unique name, else ambiguous" rule
 *  in packages/core/src/composition.ts), the stable entryId otherwise. A shared helper so the
 *  Skills list and the Skill detail page can never make this decision differently for the
 *  same Skill. */
export const cliSkillSelector = (
  skillId: string,
  name: string,
  allSkills: readonly { skillId: string; name: string }[],
): string => {
  const matches = allSkills.filter((s) => s.name === name);
  return matches.length === 1 ? name : skillId;
};
