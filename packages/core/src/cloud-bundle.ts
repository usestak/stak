import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  cloudEnvironmentBundleSchema,
  importedStackVersionSchema,
} from '@stack/spec';
import type {
  CloudEnvironmentBundle,
  CloudSnapshotRequirement,
  EnvironmentStackLayer,
  ImportedStackVersion,
  LockedSkill,
  PortableImportedStackVersion,
  PortableLockedSkill,
  PortableRestorationStrategy,
  RestorationStrategy,
} from '@stack/spec';

import { importedVersionKey } from './resolver.js';
import { loadMainEnvironment } from './state.js';

/** Deterministic JSON with lexicographically sorted object keys. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value ?? null);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};

const toPortableRestoration = (
  restoration: RestorationStrategy,
  contentHash: string,
): PortableRestorationStrategy =>
  restoration.strategy === 'reference'
    ? restoration
    : { strategy: 'snapshot', contentHash, reason: restoration.reason };

const toPortableLockedSkill = (skill: LockedSkill): PortableLockedSkill => ({
  name: skill.name,
  description: skill.description,
  contentHash: skill.contentHash,
  ...(skill.metadata ? { metadata: skill.metadata } : {}),
  ...(skill.preferredSource ? { preferredSource: skill.preferredSource } : {}),
  observedSources: skill.observedSources,
  restoration: toPortableRestoration(skill.restoration, skill.contentHash),
  ...(skill.origins ? { origins: skill.origins } : {}),
});

const toPortableImportedVersion = (
  stackId: string,
  version: ImportedStackVersion,
): PortableImportedStackVersion => ({
  schemaVersion: 1,
  stackId,
  name: version.name,
  description: version.description,
  versionHash: version.versionHash,
  requirements: version.requirements.map((requirement) => ({
    id: requirement.id,
    name: requirement.name,
    requirement: requirement.requirement,
    contentHash: requirement.contentHash,
    metadata: requirement.metadata,
    restoration: toPortableRestoration(
      requirement.restoration,
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

/**
 * The portable Environment digest. Covers the manifest, the portable resolution,
 * and active imported Stack versions. Excludes timestamps, Machine ids, paths,
 * and any sync metadata so the same portable Environment digests identically on
 * every Machine.
 */
export const computeEnvironmentDigest = (input: {
  environment: CloudEnvironmentBundle['environment'];
  resolved: CloudEnvironmentBundle['resolved'];
  importedStackVersions: PortableImportedStackVersion[];
}): string => {
  const skills = Object.fromEntries(
    Object.entries(input.resolved.skills).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  const importedStackVersions = [...input.importedStackVersions].sort((a, b) =>
    a.stackId < b.stackId ? -1 : a.stackId > b.stackId ? 1 : 0,
  );
  const digestInput = {
    schemaVersion: 1,
    environment: input.environment,
    resolved: { schemaVersion: 1, skills },
    importedStackVersions,
  };
  return `sha256:${createHash('sha256')
    .update(canonicalJson(digestInput))
    .digest('hex')}`;
};

const versionDirectory = (
  stackHome: string,
  stackId: string,
  versionHash: string,
) => path.join(stackHome, 'stacks', stackId, 'versions', versionHash.slice(7));

const loadImportedVersion = async (
  stackHome: string,
  layer: EnvironmentStackLayer,
): Promise<ImportedStackVersion> =>
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

export type BuildCloudEnvironmentBundleOptions = { stackHome: string };

/**
 * Build a cloud-neutral bundle from local `main`. The bundle carries enough
 * portable state to reconstruct the Environment on a fresh Machine: manifest,
 * resolved lock (with snapshot ids normalized to content hashes), every active
 * imported Stack version, and the private snapshot content requirements.
 */
export const buildCloudEnvironmentBundle = async (
  options: BuildCloudEnvironmentBundleOptions,
): Promise<CloudEnvironmentBundle> => {
  const state = await loadMainEnvironment({ stackHome: options.stackHome });
  const layers = state.manifest.stacks;
  const versionByKey = new Map(
    await Promise.all(
      layers.map(
        async (layer) =>
          [
            importedVersionKey(layer),
            await loadImportedVersion(options.stackHome, layer),
          ] as const,
      ),
    ),
  );
  const importedStackVersions: PortableImportedStackVersion[] = layers.map(
    (layer) => {
      const version = versionByKey.get(importedVersionKey(layer));
      if (!version)
        throw new Error(
          `Imported Stack version missing for layer ${layer.id}.`,
        );
      return toPortableImportedVersion(layer.stackId, version);
    },
  );

  const resolvedSkills: Record<string, PortableLockedSkill> = {};
  for (const [entryId, skill] of Object.entries(state.lock.skills))
    resolvedSkills[entryId] = toPortableLockedSkill(skill);

  const snapshotByHash = new Map<string, CloudSnapshotRequirement>();
  for (const skill of Object.values(state.lock.skills))
    if (skill.restoration.strategy === 'snapshot')
      snapshotByHash.set(skill.contentHash, {
        contentHash: skill.contentHash,
        reason: skill.restoration.reason,
      });
  for (const version of importedStackVersions)
    for (const requirement of version.requirements)
      if (requirement.restoration.strategy === 'snapshot')
        snapshotByHash.set(requirement.contentHash, {
          contentHash: requirement.contentHash,
          reason: requirement.restoration.reason,
        });
  const snapshotRequirements = [...snapshotByHash.values()].sort((a, b) =>
    a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0,
  );

  const resolved = { schemaVersion: 1 as const, skills: resolvedSkills };
  const digest = computeEnvironmentDigest({
    environment: state.manifest,
    resolved,
    importedStackVersions,
  });
  return cloudEnvironmentBundleSchema.parse({
    schemaVersion: 1,
    environment: state.manifest,
    resolved,
    importedStackVersions,
    snapshotRequirements,
    digest,
  });
};
