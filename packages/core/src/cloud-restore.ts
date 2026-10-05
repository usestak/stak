import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';

import {
  cloudEnvironmentBundleSchema,
  environmentLockSchema,
  environmentManifestSchema,
  importedStackSchema,
  importedStackVersionSchema,
  machineEnvironmentBaselineSchema,
  snapshotRecordSchema,
} from '@stack/spec';
import type {
  CloudEnvironmentBundle,
  EnvironmentLock,
  ImportedStackVersion,
  LockedSkill,
  MachineEnvironmentBaseline,
  PortableImportedStackVersion,
  PortableRestorationStrategy,
  RestorationStrategy,
  SnapshotRecord,
} from '@stack/spec';
import { CloudBundleInvalidError, type CloudClient } from '@stack/cloud-client';
import { extractSnapshotArchiveToStore, verifyStoredSkill } from '@stack/store';

import { computeEnvironmentDigest } from './cloud-bundle.js';
import { restoreReference, type GitExecutor } from './git-reference.js';
import { getOrCreateMachineIdentity, statePaths } from './state.js';

const exists = async (target: string) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

/** Collect every unique content hash the bundle requires, with its restoration. */
const collectContentRequirements = (
  bundle: CloudEnvironmentBundle,
): Map<string, PortableRestorationStrategy> => {
  const byHash = new Map<string, PortableRestorationStrategy>();
  for (const skill of Object.values(bundle.resolved.skills))
    if (!byHash.has(skill.contentHash))
      byHash.set(skill.contentHash, skill.restoration);
  for (const version of bundle.importedStackVersions)
    for (const requirement of version.requirements)
      if (!byHash.has(requirement.contentHash))
        byHash.set(requirement.contentHash, requirement.restoration);
  return byHash;
};

export type CloudRestorePlan = {
  desiredSkills: number;
  importedStackVersions: number;
  alreadyPresent: string[];
  snapshotDownloads: string[];
  referenceRestores: string[];
};

/** Read-only planning: what content pull would download or reacquire. */
export const planCloudRestore = async (options: {
  stackHome: string;
  bundle: CloudEnvironmentBundle;
}): Promise<CloudRestorePlan> => {
  const bundle = cloudEnvironmentBundleSchema.parse(options.bundle);
  const requirements = collectContentRequirements(bundle);
  const alreadyPresent: string[] = [];
  const snapshotDownloads: string[] = [];
  const referenceRestores: string[] = [];
  for (const [contentHash, restoration] of requirements) {
    const verification = await verifyStoredSkill({
      stackHome: options.stackHome,
      contentHash,
    });
    if (verification.state === 'available') {
      alreadyPresent.push(contentHash);
      continue;
    }
    if (restoration.strategy === 'snapshot')
      snapshotDownloads.push(contentHash);
    else referenceRestores.push(contentHash);
  }
  return {
    desiredSkills: Object.keys(bundle.resolved.skills).length,
    importedStackVersions: bundle.importedStackVersions.length,
    alreadyPresent: alreadyPresent.sort(),
    snapshotDownloads: snapshotDownloads.sort(),
    referenceRestores: referenceRestores.sort(),
  };
};

const toLocalRestoration = (
  restoration: PortableRestorationStrategy,
  snapshotIdByHash: Map<string, string>,
  contentHash: string,
): RestorationStrategy => {
  if (restoration.strategy === 'reference') return restoration;
  const snapshotId = snapshotIdByHash.get(contentHash);
  if (!snapshotId)
    throw new CloudBundleInvalidError(
      `Missing local snapshot id for ${contentHash}.`,
    );
  return { strategy: 'snapshot', snapshotId, reason: restoration.reason };
};

const toLocalImportedVersion = (
  version: PortableImportedStackVersion,
  snapshotIdByHash: Map<string, string>,
): ImportedStackVersion =>
  importedStackVersionSchema.parse({
    schemaVersion: 1,
    name: version.name,
    description: version.description,
    versionHash: version.versionHash,
    requirements: version.requirements.map((requirement) => ({
      id: requirement.id,
      name: requirement.name,
      requirement: requirement.requirement,
      contentHash: requirement.contentHash,
      metadata: requirement.metadata,
      restoration: toLocalRestoration(
        requirement.restoration,
        snapshotIdByHash,
        requirement.contentHash,
      ),
      observedSources: requirement.observedSources,
      ...(requirement.preferredSource
        ? { preferredSource: requirement.preferredSource }
        : {}),
      originStackName: requirement.originStackName,
    })),
    inheritedStacks: version.inheritedStacks,
    skippedOptional: version.skippedOptional,
  });

const versionDirectory = (
  stackHome: string,
  stackId: string,
  versionHash: string,
) => path.join(stackHome, 'stacks', stackId, 'versions', versionHash.slice(7));

const persistImportedVersion = async (
  stackHome: string,
  stackId: string,
  version: ImportedStackVersion,
) => {
  const target = versionDirectory(stackHome, stackId, version.versionHash);
  if (await exists(path.join(target, 'stack.lock.json'))) return;
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
    await rename(stage, target).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        await rm(stage, { recursive: true, force: true }).catch(
          () => undefined,
        );
        return;
      }
      throw error;
    });
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};

export type CloudRestoreResult = {
  environment: 'main';
  desiredSkills: number;
  importedStackVersions: number;
  snapshotsDownloaded: number;
  referencesRestored: number;
  reusedFromStore: number;
  localSnapshotRecords: number;
  digest: string;
};

export type ApplyCloudRestoreOptions = {
  stackHome: string;
  bundle: CloudEnvironmentBundle;
  client: Pick<CloudClient, 'downloadSnapshot'>;
  gitExecutor?: GitExecutor;
  now?: () => Date;
  idFactory?: () => string;
  platform?: NodeJS.Platform;
  arch?: string;
};

/**
 * Transactionally reconstruct local `main` from a validated cloud bundle. All
 * Skill content is acquired and verified into the immutable Store BEFORE any
 * desired state is committed; a partially restored main is never left behind.
 * Local snapshot ids are freshly generated for this Machine; the Machine
 * baseline starts with empty placements and agent bindings are untouched.
 */
export const applyCloudRestore = async (
  options: ApplyCloudRestoreOptions,
): Promise<CloudRestoreResult> => {
  const bundle = cloudEnvironmentBundleSchema.parse(options.bundle);
  const digest = computeEnvironmentDigest({
    environment: bundle.environment,
    resolved: bundle.resolved,
    importedStackVersions: bundle.importedStackVersions,
  });
  if (digest !== bundle.digest)
    throw new CloudBundleInvalidError(
      'Cloud bundle digest does not match its contents.',
    );

  const idFactory = options.idFactory ?? randomUUID;
  const now = (options.now ?? (() => new Date()))().toISOString();

  // 1. Acquire and verify all required content into the Store.
  const requirements = collectContentRequirements(bundle);
  let snapshotsDownloaded = 0;
  let referencesRestored = 0;
  let reusedFromStore = 0;
  for (const [contentHash, restoration] of requirements) {
    const verification = await verifyStoredSkill({
      stackHome: options.stackHome,
      contentHash,
    });
    if (verification.state === 'available') {
      reusedFromStore += 1;
      continue;
    }
    if (restoration.strategy === 'snapshot') {
      const downloaded = await options.client.downloadSnapshot(contentHash);
      await extractSnapshotArchiveToStore({
        stackHome: options.stackHome,
        contentHash,
        archiveHash: downloaded.archiveHash,
        bytes: downloaded.bytes,
        ...(options.now ? { now: options.now } : {}),
      });
      snapshotsDownloaded += 1;
    } else {
      await restoreReference({
        stackHome: options.stackHome,
        reference: restoration.reference,
        ...(options.gitExecutor ? { gitExecutor: options.gitExecutor } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
      referencesRestored += 1;
    }
  }

  // 2. Assign fresh local snapshot ids per snapshot-based content hash.
  const snapshotIdByHash = new Map<string, string>();
  for (const [contentHash, restoration] of requirements)
    if (restoration.strategy === 'snapshot')
      snapshotIdByHash.set(contentHash, `snap_${idFactory()}`);

  // 3. Reconstruct imported Stack versions (immutable, content-addressed).
  for (const version of bundle.importedStackVersions)
    await persistImportedVersion(
      options.stackHome,
      version.stackId,
      toLocalImportedVersion(version, snapshotIdByHash),
    );

  // 4. Build local manifest, lock, baseline (empty placements), snapshot records.
  const machine = await getOrCreateMachineIdentity({
    stackHome: options.stackHome,
    ...(options.now ? { now: options.now } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.arch ? { arch: options.arch } : {}),
  });
  const manifest = environmentManifestSchema.parse(bundle.environment);
  const lock: EnvironmentLock = {
    schemaVersion: 1,
    resolvedAt: now,
    skills: {},
  };
  const baseline: MachineEnvironmentBaseline = {
    schemaVersion: 1,
    machineId: machine.machineId,
    environment: manifest.name,
    capturedAt: now,
    skills: {},
  };
  const snapshotRecords: SnapshotRecord[] = [];
  for (const [entryId, skill] of Object.entries(bundle.resolved.skills)) {
    const restoration = toLocalRestoration(
      skill.restoration,
      snapshotIdByHash,
      skill.contentHash,
    );
    const locked: LockedSkill = {
      name: skill.name,
      description: skill.description,
      contentHash: skill.contentHash,
      ...(skill.metadata ? { metadata: skill.metadata } : {}),
      ...(skill.preferredSource
        ? { preferredSource: skill.preferredSource }
        : {}),
      observedSources: skill.observedSources,
      localContent: { available: true, contentHash: skill.contentHash },
      restoration,
      ...(skill.origins ? { origins: skill.origins } : {}),
      // Restore desired pause state carried by the bundle (absent = active).
      ...(skill.paused === true ? { paused: true } : {}),
    };
    lock.skills[entryId] = locked;
    baseline.skills[entryId] = {
      contentHash: skill.contentHash,
      locations: [],
    };
    if (restoration.strategy === 'snapshot')
      snapshotRecords.push(
        snapshotRecordSchema.parse({
          schemaVersion: 1,
          snapshotId: restoration.snapshotId,
          environmentEntryId: entryId,
          contentHash: skill.contentHash,
          createdAt: now,
          reason: restoration.reason,
        }),
      );
  }
  environmentManifestSchema.parse(manifest);
  environmentLockSchema.parse(lock);
  machineEnvironmentBaselineSchema.parse(baseline);

  // 5. Stage and atomically commit desired state (create or replace).
  await commitRestoredMain({
    stackHome: options.stackHome,
    machineId: machine.machineId,
    manifest,
    lock,
    baseline,
    snapshotRecords,
  });

  return {
    environment: 'main',
    desiredSkills: Object.keys(lock.skills).length,
    importedStackVersions: bundle.importedStackVersions.length,
    snapshotsDownloaded,
    referencesRestored,
    reusedFromStore,
    localSnapshotRecords: snapshotRecords.length,
    digest,
  };
};

const commitRestoredMain = async (input: {
  stackHome: string;
  machineId: string;
  manifest: ReturnType<typeof environmentManifestSchema.parse>;
  lock: EnvironmentLock;
  baseline: MachineEnvironmentBaseline;
  snapshotRecords: SnapshotRecord[];
}): Promise<void> => {
  const paths = statePaths(input.stackHome, input.machineId);
  const token = randomUUID();
  const stage = `${paths.environmentDirectory}.restore.${token}.tmp`;
  const backup = `${paths.environmentDirectory}.restore.${token}.bak`;
  const baselineStage = `${paths.baseline}.restore.${token}.tmp`;
  const baselineBackup = `${paths.baseline}.restore.${token}.bak`;
  const hadEnvironment = await exists(paths.environmentDirectory);
  const hadBaseline = await exists(paths.baseline);
  let environmentMoved = false;
  let environmentCommitted = false;
  let baselineMoved = false;
  const committedSnapshots: string[] = [];
  try {
    await mkdir(stage, { recursive: true });
    await writeFile(
      path.join(stage, 'environment.yaml'),
      stringifyYaml(input.manifest),
      'utf8',
    );
    await writeFile(
      path.join(stage, 'stack.lock.json'),
      `${JSON.stringify(input.lock, null, 2)}\n`,
      'utf8',
    );
    await mkdir(path.dirname(paths.baseline), { recursive: true });
    await writeFile(
      baselineStage,
      `${JSON.stringify(input.baseline, null, 2)}\n`,
      'utf8',
    );
    // Validate staged files before swapping anything in.
    environmentManifestSchema.parse(
      parseYaml(await readFile(path.join(stage, 'environment.yaml'), 'utf8')),
    );
    environmentLockSchema.parse(
      JSON.parse(await readFile(path.join(stage, 'stack.lock.json'), 'utf8')),
    );
    machineEnvironmentBaselineSchema.parse(
      JSON.parse(await readFile(baselineStage, 'utf8')),
    );

    if (input.snapshotRecords.length > 0)
      await mkdir(path.join(input.stackHome, 'snapshots'), { recursive: true });
    for (const record of input.snapshotRecords) {
      const final = path.join(
        input.stackHome,
        'snapshots',
        `${record.snapshotId}.json`,
      );
      await writeFile(final, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      committedSnapshots.push(final);
    }

    if (hadEnvironment) {
      await rename(paths.environmentDirectory, backup);
      environmentMoved = true;
    }
    await rename(stage, paths.environmentDirectory);
    environmentCommitted = true;
    if (hadBaseline) {
      await rename(paths.baseline, baselineBackup);
      baselineMoved = true;
    }
    await rename(baselineStage, paths.baseline);
    if (environmentMoved)
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    if (baselineMoved)
      await rm(baselineBackup, { force: true }).catch(() => undefined);
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    await rm(baselineStage, { force: true }).catch(() => undefined);
    for (const snapshot of committedSnapshots)
      await rm(snapshot, { force: true }).catch(() => undefined);
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
