import { randomUUID } from 'node:crypto';

import { tryResolvedEnvironmentSchema } from '@stack/spec';
import type {
  EnvironmentLock,
  EnvironmentManifest,
  EnvironmentStackLayer,
  ImportedStackVersion,
  ReferenceRecord,
  TryResolvedEnvironment,
} from '@stack/spec';
import { ingestSkill, verifyStoredSkill } from '@stack/store';

import { importedVersionKey, resolveEnvironment } from './resolver.js';
import {
  loadLocalStack,
  StackCompositionError,
  type LoadedLocalStack,
} from './stack-loader.js';
import { restoreReference, type GitExecutor } from './git-reference.js';
import {
  resolvePublicStackSource,
  type ResolvedPublicStackSource,
} from './remote-source.js';
import type { PublicStackClient } from '@stack/cloud-client';

export type TrialStackResolution = {
  loaded: LoadedLocalStack;
  resolved: TryResolvedEnvironment;
};

export const resolveTrialStack = async (options: {
  input: string;
  idFactory?: () => string;
}): Promise<TrialStackResolution> => {
  if (options.input.startsWith('@'))
    throw new StackCompositionError(
      'remote-stack-unsupported',
      'Remote Stack registry resolution is not available yet.',
    );
  const loaded = await loadLocalStack(options.input);
  const idFactory = options.idFactory ?? randomUUID;
  const layer: EnvironmentStackLayer = {
    id: `layer_${idFactory()}`,
    stackId: `stack_${idFactory()}`,
    name: loaded.version.name,
    versionHash: loaded.version.versionHash,
  };
  const manifest: EnvironmentManifest = {
    schemaVersion: 1,
    name: `try:${loaded.version.name}`,
    skills: [],
    stacks: [layer],
    overrides: {},
  };
  const lock: EnvironmentLock = {
    schemaVersion: 1,
    resolvedAt: '1970-01-01T00:00:00.000Z',
    skills: {},
  };
  const environment = resolveEnvironment({
    manifest,
    lock,
    versions: new Map([[importedVersionKey(layer), loaded.version]]),
    idFactory: () => `trial_${idFactory()}`,
  });
  if (environment.conflicts.length)
    throw new StackCompositionError(
      'try-resolution-conflict',
      `Trial Stack has ${environment.conflicts.length} required Skill conflict(s).`,
    );
  const required = environment.skills.filter((skill) =>
    skill.origins.some(
      (origin) => origin.type === 'stack' && origin.requirement === 'required',
    ),
  ).length;
  const optionalIncluded = environment.skills.length - required;
  return {
    loaded,
    resolved: tryResolvedEnvironmentSchema.parse({
      stackName: loaded.version.name,
      stackVersionHash: loaded.version.versionHash,
      environment,
      skippedOptional:
        environment.skipped.length + loaded.version.skippedOptional.length,
      required,
      optionalIncluded,
      isolation: {
        temporaryHome: true,
        temporaryCodexHome: true,
        scratchWorkspace: true,
        normalBindingsUntouched: true,
        mainUntouched: true,
      },
    }),
  };
};

export const preserveTrialStack = async (options: {
  stackHome: string;
  trial: TrialStackResolution;
  now?: () => Date;
  ingest?: typeof ingestSkill;
}): Promise<void> => {
  const ingest = options.ingest ?? ingestSkill;
  for (const requirement of options.trial.loaded.version.requirements) {
    const sourcePath = options.trial.loaded.sources.get(requirement.id);
    if (!sourcePath) continue;
    await ingest({
      stackHome: options.stackHome,
      sourcePath,
      expectedContentHash: requirement.contentHash,
      ...(options.now ? { now: options.now } : {}),
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Remote (public) trials                                                     */
/* -------------------------------------------------------------------------- */

export type RemoteTrialResolution = {
  kind: 'public';
  resolved: TryResolvedEnvironment;
  version: ImportedStackVersion;
  references: Map<string, ReferenceRecord>;
  source: {
    ref: string;
    owner: string;
    slug: string;
    publicStackId: string;
    publicVersionId: string;
    versionHash: string;
  };
};

const buildTrialResolved = (
  version: ImportedStackVersion,
  idFactory: () => string,
): TryResolvedEnvironment => {
  const layer: EnvironmentStackLayer = {
    id: `layer_${idFactory()}`,
    stackId: `stack_${idFactory()}`,
    name: version.name,
    versionHash: version.versionHash,
  };
  const manifest: EnvironmentManifest = {
    schemaVersion: 1,
    name: `try:${version.name}`,
    skills: [],
    stacks: [layer],
    overrides: {},
  };
  const lock: EnvironmentLock = {
    schemaVersion: 1,
    resolvedAt: '1970-01-01T00:00:00.000Z',
    skills: {},
  };
  const environment = resolveEnvironment({
    manifest,
    lock,
    versions: new Map([[importedVersionKey(layer), version]]),
    idFactory: () => `trial_${idFactory()}`,
  });
  if (environment.conflicts.length)
    throw new StackCompositionError(
      'try-resolution-conflict',
      `Trial Stack has ${environment.conflicts.length} required Skill conflict(s).`,
    );
  const required = environment.skills.filter((skill) =>
    skill.origins.some(
      (origin) => origin.type === 'stack' && origin.requirement === 'required',
    ),
  ).length;
  return tryResolvedEnvironmentSchema.parse({
    stackName: version.name,
    stackVersionHash: version.versionHash,
    environment,
    skippedOptional:
      environment.skipped.length + version.skippedOptional.length,
    required,
    optionalIncluded: environment.skills.length - required,
    isolation: {
      temporaryHome: true,
      temporaryCodexHome: true,
      scratchWorkspace: true,
      normalBindingsUntouched: true,
      mainUntouched: true,
    },
  });
};

export const resolveRemoteTrialStack = async (options: {
  ref: string;
  client: Pick<PublicStackClient, 'getPublicStack'>;
  idFactory?: () => string;
}): Promise<RemoteTrialResolution> => {
  const source: ResolvedPublicStackSource = await resolvePublicStackSource({
    client: options.client,
    ref: options.ref,
  });
  const resolved = buildTrialResolved(
    source.version,
    options.idFactory ?? randomUUID,
  );
  return {
    kind: 'public',
    resolved,
    version: source.version,
    references: source.references,
    source: {
      ref: source.ref,
      owner: source.owner,
      slug: source.slug,
      publicStackId: source.publicStackId,
      publicVersionId: source.publicVersionId,
      versionHash: source.versionHash,
    },
  };
};

export const preserveRemoteTrialStack = async (options: {
  stackHome: string;
  trial: RemoteTrialResolution;
  gitExecutor?: GitExecutor;
  now?: () => Date;
}): Promise<void> => {
  for (const requirement of options.trial.version.requirements) {
    const verification = await verifyStoredSkill({
      stackHome: options.stackHome,
      contentHash: requirement.contentHash,
    });
    if (verification.state === 'available') continue;
    const reference = options.trial.references.get(requirement.id);
    if (!reference)
      throw new StackCompositionError(
        'remote-reference-missing',
        `No reference is available for ${requirement.name}.`,
      );
    await restoreReference({
      stackHome: options.stackHome,
      reference,
      ...(options.gitExecutor ? { gitExecutor: options.gitExecutor } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }
};
