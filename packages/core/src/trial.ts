import { randomUUID } from 'node:crypto';

import { tryResolvedEnvironmentSchema } from '@stack/spec';
import type {
  EnvironmentLock,
  EnvironmentManifest,
  EnvironmentStackLayer,
  TryResolvedEnvironment,
} from '@stack/spec';
import { ingestSkill } from '@stack/store';

import { importedVersionKey, resolveEnvironment } from './resolver.js';
import {
  loadLocalStack,
  StackCompositionError,
  type LoadedLocalStack,
} from './stack-loader.js';

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
