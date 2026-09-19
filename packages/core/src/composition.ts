import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import {
  environmentLockSchema,
  environmentManifestSchema,
  importedStackSchema,
  importedStackVersionSchema,
  machineEnvironmentBaselineSchema,
} from '@stack/spec';
import type {
  EnvironmentLock,
  EnvironmentManifest,
  EnvironmentStackLayer,
  ImportedStackVersion,
  MachineEnvironmentBaseline,
  ResolvedEnvironment,
} from '@stack/spec';
import { ingestSkill } from '@stack/store';

import { loadLocalStack, StackCompositionError } from './stack-loader.js';
import type { LoadedLocalStack } from './stack-loader.js';
import { importedVersionKey, resolveEnvironment } from './resolver.js';
import { loadMainEnvironment, statePaths } from './state.js';
import type { LoadedEnvironmentState } from './state.js';

const versionDirectory = (
  stackHome: string,
  stackId: string,
  versionHash: string,
) => path.join(stackHome, 'stacks', stackId, 'versions', versionHash.slice(7));
const loadVersion = async (stackHome: string, layer: EnvironmentStackLayer) =>
  importedStackVersionSchema.parse(
    JSON.parse(
      await readFile(
        path.join(
          versionDirectory(stackHome, layer.stackId, layer.versionHash),
          'stack.lock.json',
        ),
        'utf8',
      ),
    ),
  );
const loadVersions = async (
  stackHome: string,
  layers: EnvironmentStackLayer[],
) =>
  new Map(
    await Promise.all(
      layers.map(
        async (layer) =>
          [
            importedVersionKey(layer),
            await loadVersion(stackHome, layer),
          ] as const,
      ),
    ),
  );

const buildState = (
  current: LoadedEnvironmentState,
  manifest: EnvironmentManifest,
  resolved: ResolvedEnvironment,
  now: string,
) => {
  const lock: EnvironmentLock = {
    schemaVersion: 1,
    resolvedAt: now,
    skills: {},
  };
  const baseline: MachineEnvironmentBaseline = {
    schemaVersion: 1,
    machineId: current.machine.machineId,
    environment: manifest.name,
    capturedAt: current.baseline.capturedAt,
    skills: {},
  };
  for (const skill of resolved.skills) {
    lock.skills[skill.entryId] = {
      name: skill.name,
      description: skill.metadata.description,
      contentHash: skill.contentHash,
      metadata: skill.metadata,
      ...(skill.preferredSource
        ? { preferredSource: skill.preferredSource }
        : {}),
      observedSources: skill.observedSources,
      localContent: { available: true, contentHash: skill.contentHash },
      restoration: skill.restoration,
      origins: skill.origins,
    };
    const previous = current.baseline.skills[skill.entryId];
    baseline.skills[skill.entryId] =
      previous?.contentHash === skill.contentHash
        ? previous
        : { contentHash: skill.contentHash, locations: [] };
  }
  return {
    manifest: environmentManifestSchema.parse(manifest),
    lock: environmentLockSchema.parse(lock),
    baseline: machineEnvironmentBaselineSchema.parse(baseline),
  };
};

const persistMain = async (
  stackHome: string,
  state: ReturnType<typeof buildState>,
) => {
  const paths = statePaths(stackHome, state.baseline.machineId);
  const token = randomUUID();
  const stage = `${paths.environmentDirectory}.${token}.tmp`;
  const backup = `${paths.environmentDirectory}.${token}.bak`;
  const baselineStage = `${paths.baseline}.${token}.tmp`;
  const baselineBackup = `${paths.baseline}.${token}.bak`;
  let environmentMoved = false;
  let environmentCommitted = false;
  let baselineMoved = false;
  try {
    await mkdir(stage, { recursive: true });
    await writeFile(
      path.join(stage, 'environment.yaml'),
      stringifyYaml(state.manifest),
      'utf8',
    );
    await writeFile(
      path.join(stage, 'stack.lock.json'),
      `${JSON.stringify(state.lock, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      baselineStage,
      `${JSON.stringify(state.baseline, null, 2)}\n`,
      'utf8',
    );
    environmentManifestSchema.parse(
      (await import('yaml')).parse(
        await readFile(path.join(stage, 'environment.yaml'), 'utf8'),
      ),
    );
    environmentLockSchema.parse(
      JSON.parse(await readFile(path.join(stage, 'stack.lock.json'), 'utf8')),
    );
    machineEnvironmentBaselineSchema.parse(
      JSON.parse(await readFile(baselineStage, 'utf8')),
    );
    await rename(paths.environmentDirectory, backup);
    environmentMoved = true;
    await rename(stage, paths.environmentDirectory);
    environmentCommitted = true;
    await rename(paths.baseline, baselineBackup);
    baselineMoved = true;
    await rename(baselineStage, paths.baseline);
    await rm(backup, { recursive: true, force: true });
    await rm(baselineBackup, { force: true });
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    await rm(baselineStage, { force: true }).catch(() => undefined);
    if (environmentCommitted)
      await rm(paths.environmentDirectory, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    if (environmentMoved)
      await rename(backup, paths.environmentDirectory).catch(() => undefined);
    if (baselineMoved) {
      await rm(paths.baseline, { force: true }).catch(() => undefined);
      await rename(baselineBackup, paths.baseline).catch(() => undefined);
    }
    throw error;
  }
};

const persistVersion = async (
  stackHome: string,
  stackId: string,
  version: ImportedStackVersion,
) => {
  const target = versionDirectory(stackHome, stackId, version.versionHash);
  try {
    await readFile(path.join(target, 'stack.lock.json'));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const stage = `${target}.${randomUUID()}.tmp`;
  try {
    await mkdir(stage, { recursive: true });
    await writeFile(
      path.join(stage, 'stack.json'),
      `${JSON.stringify(importedStackSchema.parse({ schemaVersion: 1, stackId, version }), null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(stage, 'stack.lock.json'),
      `${JSON.stringify(version, null, 2)}\n`,
      'utf8',
    );
    await mkdir(path.dirname(target), { recursive: true });
    await rename(stage, target);
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};

const sameState = (
  left: LoadedEnvironmentState,
  right: LoadedEnvironmentState,
) =>
  JSON.stringify(left.manifest) === JSON.stringify(right.manifest) &&
  JSON.stringify(left.lock) === JSON.stringify(right.lock) &&
  JSON.stringify(left.baseline) === JSON.stringify(right.baseline);

const withMainMutationLock = async <T>(
  stackHome: string,
  expected: LoadedEnvironmentState,
  operation: () => Promise<T>,
): Promise<T> => {
  const directory = path.join(stackHome, 'environments');
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, '.main.mutation.lock');
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    throw new StackCompositionError(
      'environment-mutation-in-progress',
      'main is being changed by another Stack operation.',
      { cause: error },
    );
  }
  try {
    const current = await loadMainEnvironment({ stackHome });
    if (!sameState(current, expected))
      throw new StackCompositionError(
        'environment-changed',
        'main changed after preview; run the command again.',
      );
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
};

export type StackUseProposal = {
  stackHome: string;
  current: LoadedEnvironmentState;
  loaded: LoadedLocalStack;
  layer: EnvironmentStackLayer;
  resolved: ResolvedEnvironment;
  summary: {
    alreadySatisfied: number;
    newSkills: number;
    optionalSkipped: number;
    hardConflicts: number;
    directSkills: number;
    stackLayers: number;
    resolvedSkills: number;
  };
};
export const prepareStackUse = async (options: {
  stackHome: string;
  input: string;
  idFactory?: () => string;
}): Promise<StackUseProposal> => {
  if (options.input.startsWith('@'))
    throw new StackCompositionError(
      'remote-stack-unsupported',
      'Remote Stack registry resolution is not available yet.',
    );
  const current = await loadMainEnvironment({ stackHome: options.stackHome });
  const loaded = await loadLocalStack(options.input);
  const sameName = current.manifest.stacks.find(
    (item) => item.name === loaded.version.name,
  );
  if (sameName)
    throw new StackCompositionError(
      sameName.versionHash === loaded.version.versionHash
        ? 'stack-already-active'
        : 'stack-version-conflict',
      sameName.versionHash === loaded.version.versionHash
        ? `${loaded.version.name} is already active in main.`
        : `${loaded.version.name} is active with a different version; explicit updates are not implemented.`,
    );
  const id = options.idFactory ?? randomUUID;
  const stackId = `stack_${id()}`;
  const layer: EnvironmentStackLayer = {
    id: `layer_${id()}`,
    stackId,
    name: loaded.version.name,
    versionHash: loaded.version.versionHash,
  };
  const manifest = {
    ...current.manifest,
    stacks: [...current.manifest.stacks, layer],
  };
  const versions = await loadVersions(
    options.stackHome,
    current.manifest.stacks,
  );
  versions.set(importedVersionKey(layer), loaded.version);
  const resolved = resolveEnvironment({
    manifest,
    lock: current.lock,
    versions,
    idFactory: id,
  });
  const existing = new Set(
    Object.values(current.lock.skills).map(
      (item) => `${item.name}\0${item.contentHash}`,
    ),
  );
  return {
    stackHome: options.stackHome,
    current,
    loaded,
    layer,
    resolved,
    summary: {
      alreadySatisfied: resolved.skills.filter((item) =>
        existing.has(`${item.name}\0${item.contentHash}`),
      ).length,
      newSkills: resolved.skills.filter(
        (item) => !existing.has(`${item.name}\0${item.contentHash}`),
      ).length,
      optionalSkipped:
        resolved.skipped.length + loaded.version.skippedOptional.length,
      hardConflicts: resolved.conflicts.length,
      directSkills: current.manifest.skills.length,
      stackLayers: manifest.stacks.length,
      resolvedSkills: resolved.skills.length,
    },
  };
};
export const applyStackUse = async (
  proposal: StackUseProposal,
  options: { now?: () => Date; ingest?: typeof ingestSkill } = {},
) => {
  if (proposal.resolved.conflicts.length)
    throw new StackCompositionError(
      'stack-resolution-conflict',
      'Stack has required Skill conflicts.',
    );
  await withMainMutationLock(proposal.stackHome, proposal.current, async () => {
    const ingest = options.ingest ?? ingestSkill;
    for (const requirement of proposal.loaded.version.requirements) {
      const sourcePath = proposal.loaded.sources.get(requirement.id);
      if (!sourcePath) continue;
      await ingest({
        stackHome: proposal.stackHome,
        sourcePath,
        expectedContentHash: requirement.contentHash,
        ...(options.now ? { now: options.now } : {}),
      });
    }
    await persistVersion(
      proposal.stackHome,
      proposal.layer.stackId,
      proposal.loaded.version,
    );
    const manifest = {
      ...proposal.current.manifest,
      stacks: [...proposal.current.manifest.stacks, proposal.layer],
    };
    await persistMain(
      proposal.stackHome,
      buildState(
        proposal.current,
        manifest,
        proposal.resolved,
        (options.now ?? (() => new Date()))().toISOString(),
      ),
    );
  });
  return proposal;
};

export type StackRemoveProposal = {
  stackHome: string;
  current: LoadedEnvironmentState;
  layer: EnvironmentStackLayer;
  manifest: EnvironmentManifest;
  resolved: ResolvedEnvironment;
  summary: {
    requirements: number;
    stillRequired: number;
    noLongerDesired: number;
    directSkills: number;
    stackLayers: number;
    resolvedSkills: number;
  };
};
export const prepareStackRemove = async (options: {
  stackHome: string;
  identifier: string;
  idFactory?: () => string;
}): Promise<StackRemoveProposal> => {
  const current = await loadMainEnvironment({ stackHome: options.stackHome });
  const matches = current.manifest.stacks.filter(
    (item) =>
      item.id === options.identifier ||
      item.stackId === options.identifier ||
      item.name === options.identifier,
  );
  if (!matches.length)
    throw new StackCompositionError(
      'stack-layer-not-found',
      `No active Stack matches ${options.identifier}.`,
    );
  if (matches.length > 1)
    throw new StackCompositionError(
      'stack-layer-ambiguous',
      `Multiple active Stacks match ${options.identifier}: ${matches.map((item) => item.id).join(', ')}`,
    );
  const layer = matches[0];
  if (!layer)
    throw new StackCompositionError(
      'stack-layer-not-found',
      `No active Stack matches ${options.identifier}.`,
    );
  const version = await loadVersion(options.stackHome, layer);
  const manifest = {
    ...current.manifest,
    stacks: current.manifest.stacks.filter((item) => item.id !== layer.id),
  };
  const versions = await loadVersions(options.stackHome, manifest.stacks);
  const resolved = resolveEnvironment({
    manifest,
    lock: current.lock,
    versions,
    idFactory: options.idFactory ?? randomUUID,
  });
  const previous = new Set(
    Object.values(current.lock.skills).map(
      (item) => `${item.name}\0${item.contentHash}`,
    ),
  );
  const after = new Set(
    resolved.skills.map((item) => `${item.name}\0${item.contentHash}`),
  );
  return {
    stackHome: options.stackHome,
    current,
    layer,
    manifest,
    resolved,
    summary: {
      requirements: version.requirements.length,
      stillRequired: [...previous].filter((item) => after.has(item)).length,
      noLongerDesired: [...previous].filter((item) => !after.has(item)).length,
      directSkills: manifest.skills.length,
      stackLayers: manifest.stacks.length,
      resolvedSkills: resolved.skills.length,
    },
  };
};
export const applyStackRemove = async (
  proposal: StackRemoveProposal,
  options: { now?: () => Date } = {},
) => {
  await withMainMutationLock(proposal.stackHome, proposal.current, () =>
    persistMain(
      proposal.stackHome,
      buildState(
        proposal.current,
        proposal.manifest,
        proposal.resolved,
        (options.now ?? (() => new Date()))().toISOString(),
      ),
    ),
  );
  return proposal;
};
