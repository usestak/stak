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

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  environmentLockSchema,
  environmentManifestSchema,
  machineEnvironmentBaselineSchema,
  snapshotRecordSchema,
} from '@stack/spec';
import type {
  BaselineLocation,
  EnvironmentLock,
  EnvironmentManifest,
  MachineEnvironmentBaseline,
  ScanResult,
  SnapshotRecord,
  SkillSource,
} from '@stack/spec';
import { ingestSkill } from '@stack/store';
import type { IngestSkillOptions, IngestSkillResult } from '@stack/store';

import { selectRestorationStrategy } from './restoration.js';
import {
  StackStateError,
  getOrCreateMachineIdentity,
  statePaths,
} from './state.js';

export type InitializeMainEnvironmentOptions = {
  stackHome: string;
  scanResult: ScanResult;
  now?: () => Date;
  idFactory?: () => string;
  platform?: NodeJS.Platform;
  arch?: string;
  store?: {
    ingestSkill(options: IngestSkillOptions): Promise<IngestSkillResult>;
  };
};

export type InitializeMainEnvironmentResult = {
  environment: 'main';
  importedSkills: number;
  excludedInvalid: number;
  excludedProject: number;
  physicalLocations: number;
  consolidatedDuplicates: number;
  nameCollisions: number;
  localOrUnknown: number;
  preservedContents: number;
  reusedContents: number;
  references: number;
  snapshots: number;
  integrityChecks: number;
  files: { manifest: string; lock: string; baseline: string; machine: string };
};

const stableSourceKey = (source: SkillSource): string => {
  if (source.type === 'git')
    return `git:${source.remote ?? ''}:${source.revision}:${source.path}:${String(source.clean)}`;
  if (source.type === 'unknown') return `unknown:${source.reason ?? ''}`;
  return 'local';
};

const portableSource = (source: SkillSource): SkillSource => {
  if (
    source.type !== 'git' ||
    !source.remote ||
    (!path.win32.isAbsolute(source.remote) &&
      !path.posix.isAbsolute(source.remote) &&
      !source.remote.startsWith('file:'))
  )
    return source;
  return {
    type: 'git',
    revision: source.revision,
    path: source.path,
    ...(source.clean === undefined ? {} : { clean: source.clean }),
  };
};

const sourceEvidence = (sources: SkillSource[]) => {
  const portableSources = sources.map(portableSource);
  const byKey = new Map(
    portableSources.map((source) => [stableSourceKey(source), source]),
  );
  const observedSources = [...byKey.values()].sort((left, right) =>
    stableSourceKey(left).localeCompare(stableSourceKey(right)),
  );
  const gitSources = observedSources.filter((source) => source.type === 'git');
  return {
    observedSources,
    ...(gitSources.length === 1 ? { preferredSource: gitSources[0] } : {}),
  };
};

const locationWithHash = (
  location: ScanResult['skills'][number]['locations'][number],
  contentHash: string,
): BaselineLocation => ({ ...location, contentHash });

const exists = async (target: string) => {
  try {
    await access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

export const initializeMainEnvironment = async (
  options: InitializeMainEnvironmentOptions,
): Promise<InitializeMainEnvironmentResult> => {
  if (
    options.scanResult.roots.some(
      (root) => root.scope === 'global' && root.status === 'failed',
    )
  )
    throw new StackStateError(
      'incomplete-scan',
      'Cannot create main from an incomplete scan. Review stack scan diagnostics and retry.',
    );
  const pathsWithoutMachine = statePaths(options.stackHome);
  if (await exists(pathsWithoutMachine.environmentDirectory))
    throw new StackStateError(
      'environment-exists',
      'main already exists. Use stack status to inspect it.',
    );

  const machine = await getOrCreateMachineIdentity(options);
  const paths = statePaths(options.stackHome, machine.machineId);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const idFactory = options.idFactory ?? randomUUID;
  const validGlobal = options.scanResult.skills
    .filter(
      (skill) =>
        skill.valid &&
        skill.locations.some((location) => location.scope === 'global'),
    )
    .sort((left, right) => left.contentHash.localeCompare(right.contentHash));
  const manifest: EnvironmentManifest = {
    schemaVersion: 1,
    name: 'main',
    skills: [],
    stacks: [],
    overrides: {},
  };
  const lock: EnvironmentLock = {
    schemaVersion: 1,
    resolvedAt: now,
    skills: {},
  };
  const baseline: MachineEnvironmentBaseline = {
    schemaVersion: 1,
    machineId: machine.machineId,
    environment: 'main',
    capturedAt: now,
    skills: {},
  };
  const snapshotRecords: SnapshotRecord[] = [];
  let reusedContents = 0;
  const ingest = options.store?.ingestSkill ?? ingestSkill;

  for (const discovered of validGlobal) {
    const metadata = discovered.metadata;
    if (!metadata) continue;
    const id = `skill_${idFactory()}`;
    const globalLocations = discovered.locations
      .filter((location) => location.scope === 'global')
      .sort((left, right) => left.path.localeCompare(right.path));
    const sourceLocation = globalLocations[0];
    if (!sourceLocation)
      throw new StackStateError(
        'invalid-state',
        `No global source location exists for ${metadata.name}.`,
      );
    const ingested = await ingest({
      stackHome: options.stackHome,
      sourcePath: sourceLocation.realPath ?? sourceLocation.path,
      expectedContentHash: discovered.contentHash,
      ...(options.now ? { now: options.now } : {}),
    });
    if (ingested.reused) reusedContents += 1;
    manifest.skills.push({ id, name: metadata.name, requirement: 'required' });
    const evidence = sourceEvidence(globalLocations.map((item) => item.source));
    const snapshotId = `snap_${id.slice('skill_'.length)}`;
    const restoration = selectRestorationStrategy({
      contentHash: discovered.contentHash,
      sources: globalLocations.map((item) => item.source),
      snapshotId,
    });
    if (restoration.strategy === 'snapshot')
      snapshotRecords.push(
        snapshotRecordSchema.parse({
          schemaVersion: 1,
          snapshotId,
          environmentEntryId: id,
          contentHash: discovered.contentHash,
          createdAt: now,
          reason: restoration.reason,
        }),
      );
    lock.skills[id] = {
      name: metadata.name,
      description: metadata.description,
      contentHash: discovered.contentHash,
      metadata: { name: metadata.name, description: metadata.description },
      localContent: { available: true, contentHash: discovered.contentHash },
      restoration,
      origins: [{ type: 'direct', entryId: id }],
      ...evidence,
    };
    baseline.skills[id] = {
      contentHash: discovered.contentHash,
      locations: globalLocations.map((item) =>
        locationWithHash(item, discovered.contentHash),
      ),
    };
  }
  environmentManifestSchema.parse(manifest);
  environmentLockSchema.parse(lock);
  machineEnvironmentBaselineSchema.parse(baseline);

  const token = randomUUID();
  const stagingDirectory = path.join(
    path.dirname(paths.environmentDirectory),
    `.main.${token}.tmp`,
  );
  const stagingManifest = path.join(stagingDirectory, 'environment.yaml');
  const stagingLock = path.join(stagingDirectory, 'stack.lock.json');
  const stagingBaseline = `${paths.baseline}.${token}.tmp`;
  const snapshotStages = snapshotRecords.map((record) => ({
    record,
    staging: path.join(
      options.stackHome,
      'snapshots',
      `.${record.snapshotId}.${token}.tmp`,
    ),
    final: path.join(
      options.stackHome,
      'snapshots',
      `${record.snapshotId}.json`,
    ),
  }));
  let baselineCommitted = false;
  const committedSnapshots: string[] = [];
  try {
    await mkdir(path.dirname(stagingDirectory), { recursive: true });
    await mkdir(stagingDirectory, { recursive: false });
    await writeFile(stagingManifest, stringifyYaml(manifest), 'utf8');
    await writeFile(stagingLock, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    await mkdir(path.dirname(paths.baseline), { recursive: true });
    await writeFile(stagingBaseline, `${JSON.stringify(baseline, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    if (snapshotStages.length > 0)
      await mkdir(path.join(options.stackHome, 'snapshots'), {
        recursive: true,
      });
    for (const snapshot of snapshotStages) {
      await writeFile(
        snapshot.staging,
        `${JSON.stringify(snapshot.record, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      snapshotRecordSchema.parse(
        JSON.parse(await readFile(snapshot.staging, 'utf8')),
      );
    }
    environmentManifestSchema.parse(
      parseYaml(await readFile(stagingManifest, 'utf8')),
    );
    environmentLockSchema.parse(
      JSON.parse(await readFile(stagingLock, 'utf8')),
    );
    machineEnvironmentBaselineSchema.parse(
      JSON.parse(await readFile(stagingBaseline, 'utf8')),
    );
    for (const snapshot of snapshotStages) {
      await rename(snapshot.staging, snapshot.final);
      committedSnapshots.push(snapshot.final);
    }
    await rename(stagingBaseline, paths.baseline);
    baselineCommitted = true;
    await rename(stagingDirectory, paths.environmentDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await rm(stagingBaseline, { force: true }).catch(() => undefined);
    await Promise.all(
      snapshotStages.map((snapshot) =>
        rm(snapshot.staging, { force: true }).catch(() => undefined),
      ),
    );
    await Promise.all(
      committedSnapshots.map((snapshot) =>
        rm(snapshot, { force: true }).catch(() => undefined),
      ),
    );
    if (baselineCommitted)
      await rm(paths.baseline, { force: true }).catch(() => undefined);
    throw error;
  }

  const names = new Map<string, number>();
  for (const entry of manifest.skills)
    names.set(entry.name, (names.get(entry.name) ?? 0) + 1);
  return {
    environment: 'main',
    importedSkills: manifest.skills.length,
    excludedInvalid: options.scanResult.skills.filter(
      (item) =>
        !item.valid &&
        item.locations.some((location) => location.scope === 'global'),
    ).length,
    excludedProject: options.scanResult.skills.filter((item) =>
      item.locations.every((location) => location.scope === 'project'),
    ).length,
    physicalLocations: Object.values(baseline.skills).reduce(
      (count, item) => count + item.locations.length,
      0,
    ),
    consolidatedDuplicates: validGlobal.filter(
      (item) =>
        item.locations.filter((location) => location.scope === 'global')
          .length > 1,
    ).length,
    nameCollisions: [...names.values()].filter((count) => count > 1).length,
    localOrUnknown: Object.values(lock.skills).filter(
      (item) => item.restoration.strategy === 'snapshot',
    ).length,
    preservedContents: manifest.skills.length,
    reusedContents,
    references: Object.values(lock.skills).filter(
      (item) => item.restoration.strategy === 'reference',
    ).length,
    snapshots: snapshotRecords.length,
    integrityChecks: manifest.skills.length,
    files: {
      manifest: paths.manifest,
      lock: paths.lock,
      baseline: paths.baseline,
      machine: paths.machine,
    },
  };
};
