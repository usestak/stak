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
import { ingestSkill, verifyStoredSkill } from '@stack/store';

import { loadLocalStack, StackCompositionError } from './stack-loader.js';
import type { LoadedLocalStack } from './stack-loader.js';
import { importedVersionKey, resolveEnvironment } from './resolver.js';
import { loadMainEnvironment, statePaths } from './state.js';
import type { LoadedEnvironmentState } from './state.js';
import { restoreReference, type GitExecutor } from './git-reference.js';
import type { ResolvedPublicStackSource } from './remote-source.js';

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
    // Pause is machine-local desired state carried in the lock. Re-resolving the environment
    // (use/remove) must preserve it for the SAME stable entryId so a paused Skill is not
    // silently reactivated; a re-minted entryId (changed identity) starts active.
    const previousPaused = current.lock.skills[skill.entryId]?.paused;
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
      ...(previousPaused === true ? { paused: true } : {}),
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

export const persistMainState = async (
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

export const withMainMutationLock = async <T>(
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
    await persistMainState(
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
    persistMainState(
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

/* -------------------------------------------------------------------------- */
/* Skill pause / resume (P2)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a human-friendly Skill selector to a single stable entryId. A selector that is a
 * stable entryId (`skill_…`) is matched directly; otherwise it is matched by display name.
 * Two Skills that share a name but have distinct stable ids are NEVER collapsed — a name that
 * matches more than one is reported ambiguous so the caller can fail safely. Display name is
 * never identity.
 */
export type SkillSelectorResult =
  | { status: 'ok'; entryId: string }
  | { status: 'not-found' }
  | { status: 'ambiguous'; matches: string[] };

export const resolveSkillSelector = (
  lock: EnvironmentLock,
  selector: string,
): SkillSelectorResult => {
  if (lock.skills[selector]) return { status: 'ok', entryId: selector };
  const byName = Object.entries(lock.skills)
    .filter(([, skill]) => skill.name === selector)
    .map(([entryId]) => entryId)
    .sort();
  if (byName.length === 1 && byName[0])
    return { status: 'ok', entryId: byName[0] };
  if (byName.length > 1) return { status: 'ambiguous', matches: byName };
  return { status: 'not-found' };
};

export type SetSkillPausedResult =
  | {
      status: 'ok';
      entryId: string;
      name: string;
      paused: boolean;
      changed: boolean;
    }
  | { status: 'not-found' }
  | { status: 'ambiguous'; matches: string[] };

/**
 * Pause or resume a single Skill by selector (P2, contract §6). This flips ONLY the lock's
 * machine-local `paused` flag for the selected stable entryId; version, provenance, metadata,
 * origins and history are untouched, and manifest/baseline are preserved. The change is
 * written through the same optimistic mutation lock + transactional swap as composition, so a
 * concurrent change fails closed and a write failure leaves the prior state intact. Pause is
 * NOT remove. The per-machine projection effect happens on the next `run` / `skill update`.
 */
export const setSkillPaused = async (options: {
  stackHome: string;
  selector: string;
  paused: boolean;
}): Promise<SetSkillPausedResult> => {
  const current = await loadMainEnvironment({ stackHome: options.stackHome });
  const resolved = resolveSkillSelector(current.lock, options.selector);
  if (resolved.status !== 'ok') return resolved;
  const { entryId } = resolved;
  const locked = current.lock.skills[entryId];
  if (!locked) return { status: 'not-found' };
  const wasPaused = locked.paused === true;
  if (wasPaused === options.paused)
    return {
      status: 'ok',
      entryId,
      name: locked.name,
      paused: options.paused,
      changed: false,
    };
  const nextLocked = { ...locked };
  if (options.paused) nextLocked.paused = true;
  else delete nextLocked.paused;
  const lock: EnvironmentLock = {
    ...current.lock,
    skills: { ...current.lock.skills, [entryId]: nextLocked },
  };
  await withMainMutationLock(options.stackHome, current, () =>
    persistMainState(options.stackHome, {
      manifest: environmentManifestSchema.parse(current.manifest),
      lock: environmentLockSchema.parse(lock),
      baseline: machineEnvironmentBaselineSchema.parse(current.baseline),
    }),
  );
  return {
    status: 'ok',
    entryId,
    name: locked.name,
    paused: options.paused,
    changed: true,
  };
};

/* -------------------------------------------------------------------------- */
/* Remote (public) Stack use                                                  */
/* -------------------------------------------------------------------------- */

export type StackRemoteUseProposal = {
  stackHome: string;
  current: LoadedEnvironmentState;
  source: ResolvedPublicStackSource;
  layer: EnvironmentStackLayer;
  resolved: ResolvedEnvironment;
  summary: {
    alreadySatisfied: number;
    newSkills: number;
    optionalSkipped: number;
    hardConflicts: number;
    stackLayers: number;
    resolvedSkills: number;
    references: number;
  };
};

export const prepareRemoteStackUse = async (options: {
  stackHome: string;
  source: ResolvedPublicStackSource;
  idFactory?: () => string;
}): Promise<StackRemoteUseProposal> => {
  const current = await loadMainEnvironment({ stackHome: options.stackHome });
  const byRef = current.manifest.stacks.find(
    (item) =>
      item.source?.kind === 'public' &&
      item.source.owner === options.source.owner &&
      item.source.slug === options.source.slug,
  );
  if (byRef)
    throw new StackCompositionError(
      byRef.versionHash === options.source.versionHash
        ? 'stack-already-active'
        : 'stack-remote-version-active',
      byRef.versionHash === options.source.versionHash
        ? `${options.source.ref} is already active in main.`
        : `${options.source.ref} is already active at a different version. A newer public version exists; explicit Stack updates are not implemented yet.`,
    );
  const sameName = current.manifest.stacks.find(
    (item) => item.name === options.source.version.name,
  );
  if (sameName)
    throw new StackCompositionError(
      sameName.versionHash === options.source.versionHash
        ? 'stack-already-active'
        : 'stack-version-conflict',
      sameName.versionHash === options.source.versionHash
        ? `${options.source.version.name} is already active in main.`
        : `${options.source.version.name} is active with a different version; explicit updates are not implemented.`,
    );
  const id = options.idFactory ?? randomUUID;
  const stackId = `stack_${id()}`;
  const layer: EnvironmentStackLayer = {
    id: `layer_${id()}`,
    stackId,
    name: options.source.version.name,
    versionHash: options.source.versionHash,
    source: {
      kind: 'public',
      ref: options.source.ref,
      owner: options.source.owner,
      slug: options.source.slug,
      publicStackId: options.source.publicStackId,
      publicVersionId: options.source.publicVersionId,
      versionHash: options.source.versionHash,
    },
  };
  const manifest = {
    ...current.manifest,
    stacks: [...current.manifest.stacks, layer],
  };
  const versions = await loadVersions(
    options.stackHome,
    current.manifest.stacks,
  );
  versions.set(importedVersionKey(layer), options.source.version);
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
    source: options.source,
    layer,
    resolved,
    summary: {
      alreadySatisfied: resolved.skills.filter((item) =>
        existing.has(`${item.name}\0${item.contentHash}`),
      ).length,
      newSkills: resolved.skills.filter(
        (item) => !existing.has(`${item.name}\0${item.contentHash}`),
      ).length,
      optionalSkipped: resolved.skipped.length,
      hardConflicts: resolved.conflicts.length,
      stackLayers: manifest.stacks.length,
      resolvedSkills: resolved.skills.length,
      references: options.source.references.size,
    },
  };
};

export const applyRemoteStackUse = async (
  proposal: StackRemoteUseProposal,
  options: { gitExecutor?: GitExecutor; now?: () => Date } = {},
): Promise<StackRemoteUseProposal> => {
  if (proposal.resolved.conflicts.length)
    throw new StackCompositionError(
      'stack-resolution-conflict',
      'Remote Stack has required Skill conflicts.',
    );
  await withMainMutationLock(proposal.stackHome, proposal.current, async () => {
    // Acquire and verify every reference BEFORE persisting anything. A failure
    // here throws, leaving main untouched (Store cache objects may remain).
    for (const requirement of proposal.source.version.requirements) {
      const verification = await verifyStoredSkill({
        stackHome: proposal.stackHome,
        contentHash: requirement.contentHash,
      });
      if (verification.state === 'available') continue;
      const reference = proposal.source.references.get(requirement.id);
      if (!reference)
        throw new StackCompositionError(
          'remote-reference-missing',
          `No reference is available for ${requirement.name}.`,
        );
      await restoreReference({
        stackHome: proposal.stackHome,
        reference,
        ...(options.gitExecutor ? { gitExecutor: options.gitExecutor } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    }
    await persistVersion(
      proposal.stackHome,
      proposal.layer.stackId,
      proposal.source.version,
    );
    const manifest = {
      ...proposal.current.manifest,
      stacks: [...proposal.current.manifest.stacks, proposal.layer],
    };
    await persistMainState(
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
