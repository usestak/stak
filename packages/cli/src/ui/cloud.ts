import type {
  ApplyPullResult,
  ApplyPushResult,
  PullPlan,
  PushPlan,
} from '@stack/core';

const shortDigest = (digest: string | null): string =>
  digest ? `${digest.slice(0, 22)}…` : '-';

const row = (label: string, value: string | number): string =>
  `${label.padEnd(24)}${value}\n`;

export const renderPushPlan = (plan: PushPlan, dryRun: boolean): string => {
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

export const renderPushResult = (result: ApplyPushResult): string =>
  [
    'main pushed successfully.',
    '',
    row('Cloud version', result.versionNumber).trimEnd(),
    row('Environment digest', shortDigest(result.digest)).trimEnd(),
    row('Private snapshots uploaded', result.uploaded).trimEnd(),
    '',
  ].join('\n');

export const renderPullPlan = (plan: PullPlan): string => {
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

export const renderPullResult = (result: ApplyPullResult): string => {
  if (result.status === 'noop') return 'main is already up to date.\n';
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
};
