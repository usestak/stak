import type {
  ApplyPullResult,
  ApplyPushResult,
  PublishPlan,
  PullPlan,
  PushPlan,
  StackOwnedUseProposal,
  StackRemoteUseProposal,
} from '@stack/core';
import { shortProjectId } from '@stack/memory';
import type { PublishPublicStackVersionResponse } from '@stack/spec';
import type {
  CloudBackupOutcome,
  CloudRecoverOutcome,
} from '../memory/cloud-ops.js';
import type { CanonicalPullOutcome } from '../memory/canonical-ops.js';
import type { ProjectFoldNote } from '../memory/project-fold.js';

import { block, renamedNote, skills } from './format.js';

export type RenderOptions = { verbose?: boolean };

const shortDigest = (digest: string | null): string =>
  digest ? `${digest.slice(0, 22)}…` : '-';

const row = (label: string, value: string | number): string =>
  `${label.padEnd(24)}${value}\n`;

const renderPushPlanVerbose = (plan: PushPlan, dryRun: boolean): string => {
  const lines = [
    'Environment: main',
    '',
    'Cloud',
    row('Current remote version', plan.remoteVersionNumber ?? 'none').trimEnd(),
    row(
      'Local base',
      plan.expectedLatestVersionId ? 'in sync' : 'new environment',
    ).trimEnd(),
    '',
    'Changes',
    row('Desired Skills', plan.desiredSkills).trimEnd(),
    row('STAK layers', plan.stackLayers).trimEnd(),
    '',
    'Snapshots',
    row('Already uploaded', plan.snapshotsAlready).trimEnd(),
    row('Need upload', plan.snapshotsToUpload.length).trimEnd(),
    '',
    row('References', plan.references).trimEnd(),
    '',
    row('Environment digest', shortDigest(plan.digest)).trimEnd(),
    '',
  ];
  if (plan.noop) lines.push('main is already up to date.');
  else if (dryRun)
    lines.push(
      plan.remoteExists
        ? 'A new cloud version would be created.'
        : 'Cloud Environment main would be created.',
    );
  else
    lines.push(
      plan.remoteExists
        ? 'A new cloud version will be created.'
        : 'Cloud Environment main will be created.',
    );
  return `${lines.join('\n')}\n`;
};

export const renderPushPlan = (
  plan: PushPlan,
  dryRun: boolean,
  options: RenderOptions = {},
): string => {
  if (options.verbose) return renderPushPlanVerbose(plan, dryRun);
  if (plan.noop) return block(['Everything is already up to date.']);
  return block([
    'Push preview',
    '',
    plan.remoteExists
      ? `${skills(plan.snapshotsToUpload.length)} changed.`
      : `${skills(plan.desiredSkills)} will be uploaded.`,
    plan.remoteExists
      ? 'main will be updated.'
      : 'main will be created in the cloud.',
    '',
    'No changes were made.',
  ]);
};

export const pushPlanJson = (plan: PushPlan) => ({
  environment: 'main',
  dryRun: true,
  digest: plan.digest,
  remoteExists: plan.remoteExists,
  remoteVersionNumber: plan.remoteVersionNumber,
  noop: plan.noop,
  conflict: plan.conflict
    ? { kind: plan.conflict.kind, message: plan.conflict.message }
    : null,
  desiredSkills: plan.desiredSkills,
  stackLayers: plan.stackLayers,
  references: plan.references,
  snapshots: {
    alreadyUploaded: plan.snapshotsAlready,
    needUpload: plan.snapshotsToUpload.length,
  },
  snapshotsToUpload: plan.snapshotsToUpload,
});

export const renderPushResult = (
  result: ApplyPushResult,
  options: RenderOptions = {},
): string => {
  if (options.verbose)
    return [
      'main pushed successfully.',
      '',
      row('Cloud version', result.versionNumber).trimEnd(),
      row('Environment digest', shortDigest(result.digest)).trimEnd(),
      row('Private snapshots uploaded', result.uploaded).trimEnd(),
      '',
    ].join('\n');
  const location = result.versionNumber === 1 ? 'created' : 'updated';
  return block([
    result.uploaded > 0 && `${skills(result.uploaded)} uploaded.`,
    `main ${location} in the cloud.`,
  ]);
};

const renderPullPlanVerbose = (plan: PullPlan): string => {
  const lines = [
    'Cloud main',
    '',
    row('Remote version', plan.remoteVersionNumber ?? 'none').trimEnd(),
    row(
      'Local state',
      plan.localExists
        ? plan.mode === 'replace'
          ? 'synced'
          : 'present'
        : 'none',
    ).trimEnd(),
    '',
    'Desired Skills',
    row('Remote', plan.restore?.desiredSkills ?? 0).trimEnd(),
    '',
    row(
      'Snapshots to download',
      plan.restore?.snapshotDownloads.length ?? 0,
    ).trimEnd(),
    row(
      'References to restore',
      plan.restore?.referenceRestores.length ?? 0,
    ).trimEnd(),
    row(
      'Imported STAK versions',
      plan.restore?.importedStackVersions ?? 0,
    ).trimEnd(),
    '',
    row('Environment digest', shortDigest(plan.remoteDigest)).trimEnd(),
    '',
  ];
  if (plan.mode === 'noop') lines.push('main is already up to date.');
  else {
    lines.push('Local desired state will be updated.');
    lines.push('Agent bindings will not be changed.');
  }
  return `${lines.join('\n')}\n`;
};

export const renderPullPlan = (
  plan: PullPlan,
  options: RenderOptions = {},
): string => {
  if (options.verbose) return renderPullPlanVerbose(plan);
  if (plan.mode === 'noop') return block(['Everything is already up to date.']);
  return block([
    'Pull preview',
    '',
    `${skills(plan.restore?.desiredSkills ?? 0)} will be downloaded.`,
    'Your agent setup will not be changed.',
    '',
    'No changes were made.',
  ]);
};

export const pullPlanJson = (plan: PullPlan) => ({
  environment: 'main',
  dryRun: true,
  mode: plan.mode,
  conflict: plan.conflict
    ? { kind: plan.conflict.kind, message: plan.conflict.message }
    : null,
  remoteExists: plan.remoteExists,
  remoteVersionNumber: plan.remoteVersionNumber,
  remoteDigest: plan.remoteDigest,
  localExists: plan.localExists,
  desiredSkills: plan.restore?.desiredSkills ?? 0,
  importedStackVersions: plan.restore?.importedStackVersions ?? 0,
  snapshotDownloads: plan.restore?.snapshotDownloads ?? [],
  referenceRestores: plan.restore?.referenceRestores ?? [],
  alreadyPresent: plan.restore?.alreadyPresent ?? [],
});

export const renderPullResult = (
  result: ApplyPullResult,
  options: RenderOptions = {},
): string => {
  if (result.status === 'noop')
    return block(['Everything is already up to date.']);
  if (options.verbose)
    return [
      'main pulled successfully.',
      '',
      row('Desired Skills', result.desiredSkills).trimEnd(),
      row('Imported STAK versions', result.importedStackVersions).trimEnd(),
      row('Snapshots downloaded', result.snapshotsDownloaded).trimEnd(),
      row('References restored', result.referencesRestored).trimEnd(),
      row('Environment digest', shortDigest(result.digest)).trimEnd(),
      '',
      'Local desired state restored. Run stak run <agent> to project it into agent directories.',
      '',
    ].join('\n');
  return block([
    `${skills(result.desiredSkills)} downloaded.`,
    'main is ready.',
    '',
    'Run `stak run codex` to set up Codex.',
  ]);
};

const ownerLabel = (owner: string | null) => owner ?? '<you>';

export const renderPublishPreview = (plan: PublishPlan): string => {
  const lines = [
    `Publishing STAK: ${plan.displayName}`,
    '',
    'Public ID',
    `@${ownerLabel(plan.ownerHandle)}/${plan.slug}`,
    '',
    row('Skills', plan.skillCount).trimEnd(),
    row('Reference-backed', plan.referenceCount).trimEnd(),
    row('Snapshot-backed', 0).trimEnd(),
    '',
    'Sources',
    ...plan.sourceRemotes.map((remote) => `  ${remote}`),
    '',
    'These source references will be public.',
    'Repository accessibility is not verified by STAK.',
    '',
  ];
  lines.push(
    plan.noop
      ? `@${ownerLabel(plan.ownerHandle)}/${plan.slug} is already up to date.`
      : plan.remoteExists
        ? 'A new public version will be created.'
        : `Cloud STAK @${ownerLabel(plan.ownerHandle)}/${plan.slug} will be created.`,
  );
  return `${lines.join('\n')}\n`;
};

export const publishPlanJson = (plan: PublishPlan) => ({
  dryRun: true,
  slug: plan.slug,
  owner: plan.ownerHandle,
  displayName: plan.displayName,
  skills: plan.skillCount,
  referenceBacked: plan.referenceCount,
  snapshotBacked: 0,
  remoteExists: plan.remoteExists,
  noop: plan.noop,
  versionHash: plan.bundle.stack.versionHash,
  sourceRemotes: plan.sourceRemotes,
});

export const renderPublishResult = (
  result: PublishPublicStackVersionResponse,
  plan: PublishPlan,
): string =>
  [
    `Published @${result.owner}/${result.slug}`,
    '',
    row('Version', result.version.versionNumber).trimEnd(),
    row('Skills', plan.skillCount).trimEnd(),
    '',
    'Use:',
    `stak use @${result.owner}/${result.slug}`,
    '',
    'Try:',
    `stak try @${result.owner}/${result.slug} -- <agent>`,
    'Agents: codex, claude, cursor',
    '',
    result.url,
    '',
  ].join('\n');

export const renderRemoteStackUse = (
  proposal: StackRemoteUseProposal,
  dryRun = false,
): string =>
  [
    `${dryRun ? 'Previewing' : 'Using'} public STAK: ${proposal.source.ref}`,
    '',
    row('STAK Skills', proposal.source.version.requirements.length).trimEnd(),
    row('Already satisfied', proposal.summary.alreadySatisfied).trimEnd(),
    row('New desired Skills', proposal.summary.newSkills).trimEnd(),
    row('References to restore', proposal.summary.references).trimEnd(),
    row('Hard conflicts', proposal.summary.hardConflicts).trimEnd(),
    row(
      'Renamed (same name, different content)',
      proposal.summary.renamed,
    ).trimEnd(),
    '',
    'main will become:',
    row('STAK layers', proposal.summary.stackLayers).trimEnd(),
    row('Resolved Skills', proposal.summary.resolvedSkills).trimEnd(),
    ...renamedNote(proposal.resolved.renamed),
    '',
  ].join('\n');

export const remoteUseJson = (proposal: StackRemoteUseProposal) => ({
  dryRun: true,
  stack: proposal.source.version,
  layer: proposal.layer,
  resolution: proposal.resolved,
  summary: proposal.summary,
  source: {
    ref: proposal.source.ref,
    owner: proposal.source.owner,
    slug: proposal.source.slug,
    versionHash: proposal.source.versionHash,
  },
});

/** `stak use <name>` against the caller's own Cloud named Stack (P10B §14) — never says
 *  "public", this Stack was never published. */
export const renderOwnedStackUse = (
  proposal: StackOwnedUseProposal,
  dryRun = false,
): string =>
  [
    // Explicitly "Cloud" (spec P10 correction §1) — local always wins silently over a
    // same-named owned Cloud Stack, so when this path IS taken, the source must say so
    // plainly rather than leaving "your Stack" ambiguous with the local-manifest case.
    `${dryRun ? 'Previewing' : 'Using'} your Cloud STAK: ${proposal.source.name}`,
    '',
    row('STAK Skills', proposal.source.version.requirements.length).trimEnd(),
    row('Already satisfied', proposal.summary.alreadySatisfied).trimEnd(),
    row('New desired Skills', proposal.summary.newSkills).trimEnd(),
    row('References to restore', proposal.summary.references).trimEnd(),
    row('Hard conflicts', proposal.summary.hardConflicts).trimEnd(),
    row(
      'Renamed (same name, different content)',
      proposal.summary.renamed,
    ).trimEnd(),
    '',
    'main will become:',
    row('STAK layers', proposal.summary.stackLayers).trimEnd(),
    row('Resolved Skills', proposal.summary.resolvedSkills).trimEnd(),
    ...renamedNote(proposal.resolved.renamed),
    '',
  ].join('\n');

export const ownedUseJson = (proposal: StackOwnedUseProposal) => ({
  dryRun: true,
  stack: proposal.source.version,
  layer: proposal.layer,
  resolution: proposal.resolved,
  summary: proposal.summary,
  source: {
    stackId: proposal.source.stackId,
    name: proposal.source.name,
    versionHash: proposal.source.versionHash,
  },
});

/* -------------------------------------------------------------------------- */
/* Unified push/pull (Skills + Memory) — Phase 3                               */
/* -------------------------------------------------------------------------- */

export type PushSkillOutcome =
  | { status: 'applied'; result: ApplyPushResult }
  | { status: 'noop' }
  | { status: 'failed'; error: string };

/** What `applyMemoryPush` can return: a real Cloud attempt, or "nothing is staged yet"
 * (no local Memory manifest — `stak add .` has never run) — distinct from `skipped`
 * (not signed in), since the fix is different (`stak add .` vs. `stak login`). */
export type MemoryPushOutcome =
  CloudBackupOutcome | { status: 'nothing-staged' };

export type PushMemoryOutcome =
  | { status: 'not-attempted' }
  | { status: 'applied'; outcome: MemoryPushOutcome }
  | { status: 'failed'; error: string };

/** True when any part of the push did not fully succeed — never say "Push complete." */
export const pushFailed = (
  skill: PushSkillOutcome,
  memory: PushMemoryOutcome,
): boolean =>
  skill.status === 'failed' ||
  memory.status === 'failed' ||
  (memory.status === 'applied' && memory.outcome.status === 'failed');

/** True when NEITHER domain changed anything — no Skill version and no Memory
 * generation were created. "Push complete." would overclaim; say "Nothing to push." */
export const pushWasNoop = (
  skill: PushSkillOutcome,
  memory: PushMemoryOutcome,
): boolean =>
  skill.status === 'noop' &&
  (memory.status === 'not-attempted' ||
    (memory.status === 'applied' &&
      (memory.outcome.status === 'nothing-staged' ||
        memory.outcome.status === 'up-to-date' ||
        memory.outcome.status === 'skipped' ||
        memory.outcome.status === 'protected-locked')));

export const renderCombinedPushResult = (
  skill: PushSkillOutcome,
  memory: PushMemoryOutcome,
): string => {
  const lines: string[] = ['Skills'];
  if (skill.status === 'noop') lines.push('  already up to date with main.');
  else if (skill.status === 'failed') lines.push(`  FAILED: ${skill.error}`);
  else {
    const location = skill.result.versionNumber === 1 ? 'created' : 'updated';
    lines.push(
      skill.result.uploaded > 0
        ? `  ${skills(skill.result.uploaded)} uploaded; main ${location} in the cloud.`
        : `  main ${location} in the cloud.`,
    );
  }
  lines.push('', 'Memory');
  if (memory.status === 'not-attempted') lines.push('  not attempted.');
  else if (memory.status === 'failed') lines.push(`  FAILED: ${memory.error}`);
  else {
    const outcome = memory.outcome;
    if (outcome.status === 'nothing-staged')
      lines.push(
        '  nothing staged yet — run `stak add .` to stage Memory changes.',
      );
    else if (outcome.status === 'up-to-date') {
      const notes = canonicalExtraNotes({
        unavailable: outcome.unavailable,
        conflicts: outcome.materializeConflicts,
        restoredFromStak: outcome.restoredFromStak,
        folded: outcome.folded,
      });
      lines.push(
        notes.length > 0
          ? `  already up to date (generation ${outcome.generation}); ${notes.join('; ')}.`
          : `  already up to date (generation ${outcome.generation}).`,
      );
    } else if (outcome.status === 'skipped')
      lines.push('  staged locally (sign in to sync Memory to Cloud).');
    else if (outcome.status === 'protected-locked')
      lines.push(
        '  staged locally; Cloud sync needs this device unlocked (`stak memory recover --passkey` or `--recovery-file <path>`).',
      );
    else if (outcome.status === 'failed')
      lines.push(`  staged locally; Cloud sync FAILED: ${outcome.message}`);
    // 'conflict' is unreachable in practice here — `applyMemoryPush` (program.ts)
    // throws before ever returning it as part of this outcome — but handled for
    // type completeness since `CloudBackupOutcome` (shared with `stak memory
    // backup`) now includes it.
    else if (outcome.status === 'conflict')
      lines.push(
        `  ${outcome.conflicts.length} unresolved conflict(s) with Cloud.`,
      );
    else {
      const notes = canonicalExtraNotes({
        unavailable: outcome.unavailable,
        conflicts: outcome.materializeConflicts,
        restoredFromStak: outcome.restoredFromStak,
        folded: outcome.folded,
      });
      lines.push(
        notes.length > 0
          ? `  synced to Cloud (generation ${outcome.generation}); ${notes.join('; ')}.`
          : `  synced to Cloud (generation ${outcome.generation}).`,
      );
    }
  }
  lines.push(
    '',
    pushFailed(skill, memory)
      ? 'Push did not fully succeed.'
      : pushWasNoop(skill, memory)
        ? 'Nothing to push.'
        : 'Push complete.',
  );
  return `${lines.join('\n')}\n`;
};

export type PullSkillOutcome =
  | { status: 'applied'; result: ApplyPullResult }
  | { status: 'noop' }
  | { status: 'failed'; error: string };

export type PullMemoryOutcome =
  | { status: 'not-attempted' }
  | { status: 'skipped'; reason: string }
  | { status: 'applied'; outcome: CloudRecoverOutcome }
  | { status: 'failed'; error: string };

/**
 * True when any part of the pull did not fully succeed. A fresh-machine Memory
 * recover that returned a status (rather than throwing) is NOT a failure:
 * - `no-backup`: the account has no Memory in Cloud yet (e.g. Skills-only).
 *   There is nothing to recover; reported as "no Cloud Memory backup exists yet."
 * - `needs-recovery-method`: Protected Memory is locked on this device. A
 *   friendly, actionable status, the same as push's `protected-locked`.
 * - `not-authenticated`: no Cloud session, the same as push's `skipped`.
 * Genuine errors (a thrown recover, a busy Memory lock) arrive as
 * `memory.status === 'failed'` and still fail the pull.
 */
export const pullFailed = (
  skill: PullSkillOutcome,
  memory: PullMemoryOutcome,
): boolean => skill.status === 'failed' || memory.status === 'failed';

/** `stak pull`'s canonical (Project) Memory half (Task 13) — an ADDITIVE operation
 * alongside the legacy fresh-machine `PullMemoryOutcome` above; it runs on every
 * pull, not only a fresh machine, and never publishes. Deliberately excluded from
 * `pullFailed`: a canonical sync failure is reported on its own line but does not
 * (by itself) make the whole `stak pull` command report failure. */
export type PullCanonicalOutcome =
  | { status: 'not-attempted' }
  | { status: 'applied'; outcome: CanonicalPullOutcome }
  | { status: 'failed'; error: string };

/** Spec §4.2.1's one line per folded project, e.g. "Merged project prj_rvznx…
 * into prj_4f68… (same repository); 1 file kept both". */
export const projectFoldNotes = (
  folded: readonly ProjectFoldNote[] | undefined,
): string[] =>
  (folded ?? []).map(
    (note) =>
      `Merged project ${shortProjectId(note.fromProjectId)} into ${shortProjectId(note.toProjectId)} (same repository)` +
      (note.keptBoth > 0
        ? `; ${note.keptBoth} file${note.keptBoth === 1 ? '' : 's'} kept both`
        : ''),
  );

/** A short, terse line for a non-`up-to-date` canonical outcome — `null` when
 * there is nothing worth saying (not attempted, or already up to date). */
/** Unavailable-project and native-conflict notes shared by push's and pull's
 * canonical rendering (Task 13 Important-5) — never silently dropped. */
export const canonicalExtraNotes = (outcome: {
  unavailable?: { projectId: string; name: string }[] | undefined;
  conflicts?: { projectId: string; path: string; reason: string }[] | undefined;
  restoredFromStak?: number | undefined;
  folded?: ProjectFoldNote[] | undefined;
}): string[] => {
  // Spec §4.2.1: one line per merged project, first — it explains the rest.
  const notes: string[] = projectFoldNotes(outcome.folded);
  // Task 13 fix round 4: files the upgrade found missing natively and wrote
  // back from STAK (never silently recorded as deletions).
  if (outcome.restoredFromStak && outcome.restoredFromStak > 0)
    notes.push(
      `${outcome.restoredFromStak} Memory file(s) will be restored from STAK`,
    );
  if (outcome.unavailable && outcome.unavailable.length > 0)
    notes.push(
      `${outcome.unavailable.length} project(s) not available on this machine (${outcome.unavailable
        .map((p) => p.name)
        .join(', ')})`,
    );
  if (outcome.conflicts && outcome.conflicts.length > 0) {
    // Task 13 fix round 2 (Minor): a materialize EXCEPTION (marked by the
    // empty `path` `materializeCanonicalProjects` uses for it — see its own
    // doc comment) is a warning with its own message, never folded into the
    // generic "N native conflict(s)" count meant for ordinary sync conflicts.
    const materializeErrors = outcome.conflicts.filter((c) => c.path === '');
    const syncConflicts = outcome.conflicts.filter((c) => c.path !== '');
    for (const error of materializeErrors)
      notes.push(`materialize warning: ${error.reason}`);
    // Final review I4: these are local agent-vs-STAK conflicts (`stak add .`
    // alone doesn't clear them); `stak status` gives the fix for each.
    if (syncConflicts.length > 0)
      notes.push(
        `${syncConflicts.length} agent file(s) differ from STAK and weren't overwritten (${syncConflicts
          .map((c) => c.path)
          .join(', ')}) — run \`stak status\` for how to fix each`,
      );
  }
  return notes;
};

const canonicalPullLine = (canonical: PullCanonicalOutcome): string | null => {
  if (canonical.status === 'not-attempted') return null;
  if (canonical.status === 'failed')
    return `  Project Memory sync FAILED: ${canonical.error}`;
  const outcome = canonical.outcome;
  if (outcome.status === 'conflict')
    return `  Project Memory has ${outcome.conflicts?.length ?? 0} unresolved conflict(s) — run \`stak memory resolve\`.`;
  if (outcome.status === 'protected-locked')
    return '  Project Memory sync needs this device unlocked (`stak memory recover --passkey` or `--recovery-file <path>`).';
  const notes = canonicalExtraNotes(outcome);
  if (outcome.status === 'up-to-date' && notes.length === 0) return null;
  const head =
    outcome.status === 'up-to-date'
      ? 'Project Memory up to date'
      : 'Project Memory synced';
  return notes.length > 0 ? `  ${head}; ${notes.join('; ')}.` : `  ${head}.`;
};

/**
 * `stak pull` with no Skills changes on an established machine: only Project Memory
 * is synced. A sync that changes nothing reads exactly like the plain no-op pull.
 * `lockError` is a busy Memory lock, which is a Memory failure (like any other).
 */
export const renderProjectMemoryOnlyPull = (
  canonical: PullCanonicalOutcome,
  lockError?: string,
): string => {
  const line = lockError
    ? `  FAILED: ${lockError}`
    : canonicalPullLine(canonical);
  if (line === null) return block(['Everything is already up to date.']);
  return block([
    'Skills',
    '  already up to date with main.',
    '',
    'Memory',
    line,
    '',
    lockError ? 'Pull did not fully succeed.' : 'Pull complete.',
  ]);
};

export const renderCombinedPullResult = (
  skill: PullSkillOutcome,
  memory: PullMemoryOutcome,
  canonical?: PullCanonicalOutcome,
): string => {
  const lines: string[] = ['Skills'];
  if (skill.status === 'noop') lines.push('  already up to date with main.');
  else if (skill.status === 'failed') lines.push(`  FAILED: ${skill.error}`);
  else if (skill.result.status === 'noop')
    lines.push('  already up to date with main.');
  else lines.push(`  ${skills(skill.result.desiredSkills)} downloaded.`);

  lines.push('', 'Memory');
  if (memory.status === 'not-attempted') lines.push('  not attempted.');
  else if (memory.status === 'skipped')
    lines.push(
      `  skipped — ${memory.reason}`,
      '  Run `stak memory recover` explicitly if you want to overwrite it.',
    );
  else if (memory.status === 'failed') lines.push(`  FAILED: ${memory.error}`);
  else {
    const outcome = memory.outcome;
    if (outcome.status === 'recovered')
      lines.push(
        `  ${outcome.files} file${outcome.files === 1 ? '' : 's'} recovered (generation ${outcome.generation}).`,
      );
    else if (outcome.status === 'no-backup')
      lines.push('  no Cloud Memory backup exists yet.');
    else if (outcome.status === 'not-authenticated')
      lines.push('  not signed in — sign in to recover Memory.');
    else
      lines.push(
        '  this device needs a recovery method to unlock Protected Memory (`stak memory recover`).',
      );
  }
  if (canonical) {
    const line = canonicalPullLine(canonical);
    if (line) lines.push(line);
  }
  lines.push(
    '',
    pullFailed(skill, memory)
      ? 'Pull did not fully succeed.'
      : 'Pull complete.',
  );
  if (
    !pullFailed(skill, memory) &&
    skill.status === 'applied' &&
    skill.result.status === 'restored'
  )
    lines.push(
      '',
      'main is ready. Run `stak run <agent>` (e.g. `stak run codex`) to set it up here.',
    );
  return `${lines.join('\n')}\n`;
};
