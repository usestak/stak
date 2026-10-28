import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  bindingRegistrySchema,
  environmentDiffSchema,
  environmentStatusSchema,
} from '@stack/spec';
import type {
  BindingRecord,
  BaselineLocation,
  DiscoveredSkill,
  EnvironmentDiff,
  EnvironmentStatus,
  PlacementDrift,
  ScanResult,
  ScannedRoot,
  SkillStatus,
} from '@stack/spec';
import { verifyStoredSkill } from '@stack/store';

import { loadMainEnvironment } from './state.js';

export type ObserveMainEnvironmentOptions = {
  stackHome: string;
  scanResult: ScanResult;
  now?: () => Date;
  store?: {
    verifyStoredSkill(options: {
      stackHome: string;
      contentHash: string;
    }): ReturnType<typeof verifyStoredSkill>;
  };
};

const pathKey = (value: string): string => {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const observedLocation = (
  location: DiscoveredSkill['locations'][number],
  contentHash: string,
): BaselineLocation => ({ ...location, contentHash });

const failedForLocation = (
  location: BaselineLocation,
  failedRoots: ScannedRoot[],
): ScannedRoot[] =>
  failedRoots.filter(
    (root) =>
      root.scope === location.scope &&
      root.rootKind === location.rootKind &&
      pathKey(root.path) === pathKey(location.rootPath),
  );

const comparePlacement = (
  entryId: string,
  name: string,
  previous: BaselineLocation[],
  current: BaselineLocation[],
  failedRoots: ScannedRoot[],
): PlacementDrift[] => {
  const result: PlacementDrift[] = [];
  const previousByPath = new Map(
    previous.map((item) => [pathKey(item.path), item]),
  );
  const currentByPath = new Map(
    current.map((item) => [pathKey(item.path), item]),
  );
  for (const [key, before] of previousByPath) {
    const after = currentByPath.get(key);
    if (!after) {
      if (failedForLocation(before, failedRoots).length === 0)
        result.push({
          entryId,
          name,
          kind: 'removed',
          rootKind: before.rootKind,
          scope: before.scope,
          path: before.path,
          previous: before,
        });
      continue;
    }
    if (
      before.isSymlink !== after.isSymlink ||
      (before.realPath ? pathKey(before.realPath) : undefined) !==
        (after.realPath ? pathKey(after.realPath) : undefined)
    )
      result.push({
        entryId,
        name,
        kind: 'changed',
        rootKind: after.rootKind,
        scope: after.scope,
        path: after.path,
        previous: before,
        current: after,
      });
  }
  for (const [key, after] of currentByPath)
    if (!previousByPath.has(key))
      result.push({
        entryId,
        name,
        kind: 'added',
        rootKind: after.rootKind,
        scope: after.scope,
        path: after.path,
        current: after,
      });
  return result;
};

/**
 * This machine's agent binding records (what `stak run <agent>` installed here). Read-only and
 * best-effort: a missing or unreadable registry is treated as "no bindings", which can only
 * make status say "not installed here" rather than "missing" — never the reverse, so it can
 * never steer the user towards `stak remove`.
 */
const readMachineBindings = async (
  stackHome: string,
  machineId: string,
): Promise<BindingRecord[]> => {
  try {
    const registry = bindingRegistrySchema.parse(
      JSON.parse(
        await readFile(
          path.join(stackHome, 'state', 'machines', machineId, 'bindings.json'),
          'utf8',
        ),
      ),
    );
    return registry.machineId === machineId ? registry.bindings : [];
  } catch {
    return [];
  }
};

export const statusMainEnvironment = async (
  options: ObserveMainEnvironmentOptions,
): Promise<EnvironmentStatus> => {
  const saved = await loadMainEnvironment({ stackHome: options.stackHome });
  const currentSkills = options.scanResult.skills.filter((skill) =>
    skill.locations.some((location) => location.scope === 'global'),
  );
  const validCurrent = currentSkills.filter(
    (
      skill,
    ): skill is DiscoveredSkill & {
      metadata: NonNullable<DiscoveredSkill['metadata']>;
    } => skill.valid && skill.metadata !== undefined,
  );
  const byHash = new Map(
    validCurrent.map((skill) => [skill.contentHash, skill]),
  );
  const byPath = new Map<string, DiscoveredSkill>();
  for (const skill of currentSkills)
    for (const location of skill.locations.filter(
      (item) => item.scope === 'global',
    ))
      byPath.set(pathKey(location.path), skill);
  const failedRoots = options.scanResult.roots.filter(
    (root) => root.scope === 'global' && root.status === 'failed',
  );
  const assignedModifiedHashes = new Set<string>();
  const skills: SkillStatus[] = [];
  const placementDrift: PlacementDrift[] = [];
  const verify = options.store?.verifyStoredSkill ?? verifyStoredSkill;
  const bindings = (
    await readMachineBindings(options.stackHome, saved.machine.machineId)
  ).filter((record) => record.environment === saved.manifest.name);

  for (const [entryId, locked] of Object.entries(saved.lock.skills)) {
    const entry = { id: entryId, name: locked.name };
    const baseline = saved.baseline.skills[entry.id] ?? {
      contentHash: locked.contentHash,
      locations: [],
    };
    if (!locked || !baseline) continue;
    const exact = byHash.get(locked.contentHash);
    const modified = baseline.locations
      .map((item) => byPath.get(pathKey(item.path)))
      .find((item) => item && item.contentHash !== locked.contentHash);
    const uncertaintyRoots = baseline.locations.flatMap((item) =>
      failedForLocation(item, failedRoots),
    );
    const uniqueUncertainty = [
      ...new Map(
        uncertaintyRoots.map((root) => [pathKey(root.path), root]),
      ).values(),
    ];
    // Was this exact Skill ever placed on THIS machine? Either it was captured from here
    // (`init`/`add` record its placements in the machine baseline) or `stak run <agent>`
    // bound this content here. `stak pull` deliberately starts with empty placements and no
    // bindings, so a freshly pulled Skill is "not installed here yet", not "missing".
    const placedOnThisMachine =
      baseline.locations.length > 0 ||
      bindings.some(
        (record) =>
          record.environmentEntryId === entry.id &&
          record.contentHash === locked.contentHash,
      );
    const stateName: SkillStatus['state'] = exact
      ? 'satisfied'
      : modified
        ? 'modified'
        : uniqueUncertainty.length > 0
          ? 'uncertain'
          : placedOnThisMachine
            ? 'missing'
            : 'not-installed';
    if (stateName === 'modified' && modified)
      assignedModifiedHashes.add(modified.contentHash);
    const currentLocations = exact
      ? exact.locations
          .filter((item) => item.scope === 'global')
          .map((item) => observedLocation(item, exact.contentHash))
      : modified
        ? modified.locations
            .filter(
              (item) =>
                item.scope === 'global' &&
                baseline.locations.some(
                  (prior) => pathKey(prior.path) === pathKey(item.path),
                ),
            )
            .map((item) => observedLocation(item, modified.contentHash))
        : [];
    const skillStatus: SkillStatus = {
      entryId: entry.id,
      name: entry.name,
      state: stateName,
      desiredHash: locked.contentHash,
      ...(modified && !exact ? { currentHash: modified.contentHash } : {}),
      ...(locked.preferredSource
        ? { desiredSource: locked.preferredSource }
        : {}),
      ...(exact
        ? { currentSource: exact.source }
        : modified
          ? { currentSource: modified.source }
          : {}),
      baselineLocations: baseline.locations,
      currentLocations,
      uncertaintyRoots: uniqueUncertainty,
      preservation: await verify({
        stackHome: options.stackHome,
        contentHash: locked.contentHash,
      }),
      restorationStrategy: locked.restoration.strategy,
      ...(locked.origins ? { origins: locked.origins } : {}),
    };
    skills.push(skillStatus);
    placementDrift.push(
      ...comparePlacement(
        entry.id,
        entry.name,
        baseline.locations,
        currentLocations,
        failedRoots,
      ),
    );
  }

  const desiredHashes = new Set(
    Object.values(saved.lock.skills).map((item) => item.contentHash),
  );
  const untracked = validCurrent
    .filter(
      (skill) =>
        !desiredHashes.has(skill.contentHash) &&
        !assignedModifiedHashes.has(skill.contentHash),
    )
    .map((skill) => ({
      name: skill.metadata.name,
      contentHash: skill.contentHash,
      source: skill.source,
      locations: skill.locations
        .filter((item) => item.scope === 'global')
        .map((item) => observedLocation(item, skill.contentHash)),
    }));
  const invalidSkills = currentSkills
    .filter((skill) => !skill.valid)
    .map((skill) => {
      const globalLocations = skill.locations.filter(
        (item) => item.scope === 'global',
      );
      return {
        contentHash: skill.contentHash,
        ...(skill.metadata?.name ? { name: skill.metadata.name } : {}),
        locations: globalLocations.map((item) =>
          observedLocation(item, skill.contentHash),
        ),
        diagnostics: options.scanResult.diagnostics.filter((diagnostic) =>
          globalLocations.some(
            (location) =>
              diagnostic.path !== undefined &&
              (pathKey(diagnostic.path) === pathKey(location.path) ||
                pathKey(diagnostic.path).startsWith(
                  `${pathKey(location.path)}${path.sep}`,
                )),
          ),
        ),
      };
    });
  const count = (stateName: SkillStatus['state']) =>
    skills.filter((item) => item.state === stateName).length;
  return environmentStatusSchema.parse({
    schemaVersion: 1,
    environment: saved.manifest.name,
    observedAt: (options.now ?? (() => new Date()))().toISOString(),
    desiredCount: Object.keys(saved.lock.skills).length,
    skills,
    untracked,
    placementDrift,
    invalidSkills,
    rootFailures: failedRoots,
    stacks: saved.manifest.stacks,
    summary: {
      satisfied: count('satisfied'),
      modified: count('modified'),
      missing: count('missing'),
      notInstalled: count('not-installed'),
      uncertain: count('uncertain'),
      untracked: untracked.length,
      placementAdded: placementDrift.filter((item) => item.kind === 'added')
        .length,
      placementRemoved: placementDrift.filter((item) => item.kind === 'removed')
        .length,
      placementChanged: placementDrift.filter((item) => item.kind === 'changed')
        .length,
      invalid: invalidSkills.length,
      rootFailures: failedRoots.length,
      preservation: {
        available: skills.filter(
          (item) => item.preservation.state === 'available',
        ).length,
        missing: skills.filter((item) => item.preservation.state === 'missing')
          .length,
        corrupt: skills.filter((item) => item.preservation.state === 'corrupt')
          .length,
      },
      restoration: {
        reference: skills.filter(
          (item) => item.restorationStrategy === 'reference',
        ).length,
        snapshot: skills.filter(
          (item) => item.restorationStrategy === 'snapshot',
        ).length,
      },
    },
  });
};

export const diffMainEnvironment = async (
  options: ObserveMainEnvironmentOptions,
): Promise<EnvironmentDiff> => {
  const status = await statusMainEnvironment(options);
  return environmentDiffSchema.parse({ ...status, entries: status.skills });
};
