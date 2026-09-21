import type {
  ApplyPullResult,
  ApplyPushResult,
  PublishPlan,
  PullPlan,
  PushPlan,
  StackRemoteUseProposal,
} from '@stack/core';
import type { PublishPublicStackVersionResponse } from '@stack/spec';

import { block, skills } from './format.js';

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
    row('Stack layers', plan.stackLayers).trimEnd(),
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
      'Imported Stack versions',
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
      row('Imported Stack versions', result.importedStackVersions).trimEnd(),
      row('Snapshots downloaded', result.snapshotsDownloaded).trimEnd(),
      row('References restored', result.referencesRestored).trimEnd(),
      row('Environment digest', shortDigest(result.digest)).trimEnd(),
      '',
      'Local desired state restored. Run stack run <agent> to project it into agent directories.',
      '',
    ].join('\n');
  return block([
    `${skills(result.desiredSkills)} downloaded.`,
    'main is ready.',
    '',
    'Run `stack run codex` to set up Codex.',
  ]);
};

const ownerLabel = (owner: string | null) => owner ?? '<you>';

export const renderPublishPreview = (plan: PublishPlan): string => {
  const lines = [
    `Publishing Stack: ${plan.displayName}`,
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
    'Repository accessibility is not verified by Stack.',
    '',
  ];
  lines.push(
    plan.noop
      ? `@${ownerLabel(plan.ownerHandle)}/${plan.slug} is already up to date.`
      : plan.remoteExists
        ? 'A new public version will be created.'
        : `Cloud Stack @${ownerLabel(plan.ownerHandle)}/${plan.slug} will be created.`,
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
    `stack use @${result.owner}/${result.slug}`,
    '',
    'Try:',
    `stack try @${result.owner}/${result.slug} -- codex`,
    '',
    result.url,
    '',
  ].join('\n');

export const renderRemoteStackUse = (
  proposal: StackRemoteUseProposal,
  dryRun = false,
): string =>
  [
    `${dryRun ? 'Previewing' : 'Using'} public Stack: ${proposal.source.ref}`,
    '',
    row('Stack Skills', proposal.source.version.requirements.length).trimEnd(),
    row('Already satisfied', proposal.summary.alreadySatisfied).trimEnd(),
    row('New desired Skills', proposal.summary.newSkills).trimEnd(),
    row('References to restore', proposal.summary.references).trimEnd(),
    row('Hard conflicts', proposal.summary.hardConflicts).trimEnd(),
    '',
    'main will become:',
    row('Stack layers', proposal.summary.stackLayers).trimEnd(),
    row('Resolved Skills', proposal.summary.resolvedSkills).trimEnd(),
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
