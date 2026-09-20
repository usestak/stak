import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  importedStackVersionSchema,
  inspectPublicSourceRemote,
  publicStackBundleSchema,
} from '@stack/spec';
import type {
  EnvironmentStackLayer,
  ImportedStackVersion,
  PublicStackBundle,
} from '@stack/spec';
import { sha256CanonicalJson } from '@stack/shared';
import { PublicationNotEligibleError } from '@stack/cloud-client';

import {
  loadLocalStack,
  StackCompositionError,
  stackVersionHash,
} from './stack-loader.js';
import { loadMainEnvironment } from './state.js';

/** Canonical digest input for a public bundle (must match the server). */
export const publicBundleDigestInput = (bundle: {
  stack: PublicStackBundle['stack'];
  requirements: PublicStackBundle['requirements'];
  inheritedStackMetadata: PublicStackBundle['inheritedStackMetadata'];
}) => ({
  stack: bundle.stack,
  requirements: bundle.requirements,
  inheritedStackMetadata: bundle.inheritedStackMetadata,
});

/**
 * Build a reference-only public Stack bundle from a resolved imported version.
 * Blocks publication when any Skill is snapshot-backed (private) or its source
 * remote is unsafe to expose publicly.
 */
export const buildPublicStackBundle = (
  version: ImportedStackVersion,
): PublicStackBundle => {
  const snapshotBacked = version.requirements.filter(
    (requirement) => requirement.restoration.strategy === 'snapshot',
  );
  if (snapshotBacked.length > 0)
    throw new PublicationNotEligibleError(
      `Cannot publish ${version.name}. ${snapshotBacked.length} Skill(s) require private snapshots: ${snapshotBacked
        .map((requirement) => requirement.name)
        .join(', ')}. Public snapshot publishing is not supported in V0.`,
    );

  const unsafe: string[] = [];
  const requirements = version.requirements.map((requirement) => {
    if (requirement.restoration.strategy !== 'reference')
      throw new PublicationNotEligibleError(
        `Skill ${requirement.name} is not reference-backed.`,
      );
    const verdict = inspectPublicSourceRemote(
      requirement.restoration.reference.remote,
    );
    if (!verdict.safe) unsafe.push(`${requirement.name} (${verdict.reason})`);
    return {
      id: requirement.id,
      name: requirement.name,
      requirement: requirement.requirement,
      contentHash: requirement.contentHash,
      metadata: requirement.metadata,
      restoration: requirement.restoration,
      observedSources: requirement.observedSources,
      ...(requirement.preferredSource
        ? { preferredSource: requirement.preferredSource }
        : {}),
      originStackName: requirement.originStackName,
    };
  });
  if (unsafe.length > 0)
    throw new PublicationNotEligibleError(
      `Cannot publish ${version.name}. Unsafe public source references: ${unsafe.join(', ')}.`,
    );

  const inheritedStackMetadata = version.inheritedStacks;
  // Deterministic, path-free public version hash over the public content only
  // (skipped-optional authoring diagnostics are excluded to avoid leaking paths).
  const versionHash = stackVersionHash({
    name: version.name,
    description: version.description,
    requirements,
    inheritedStacks: inheritedStackMetadata,
    skippedOptional: [],
  });
  const stack = {
    name: version.name,
    description: version.description,
    versionHash,
  };
  const digest = sha256CanonicalJson(
    publicBundleDigestInput({ stack, requirements, inheritedStackMetadata }),
  );
  return publicStackBundleSchema.parse({
    schemaVersion: 1,
    stack,
    requirements,
    inheritedStackMetadata,
    digest,
  });
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

const loadImportedVersion = async (
  stackHome: string,
  layer: EnvironmentStackLayer,
): Promise<ImportedStackVersion> =>
  importedStackVersionSchema.parse(
    JSON.parse(
      await readFile(
        path.join(
          stackHome,
          'stacks',
          layer.stackId,
          'versions',
          layer.versionHash.slice(7),
          'stack.lock.json',
        ),
        'utf8',
      ),
    ),
  );

export type PublishSource = {
  version: ImportedStackVersion;
  origin: 'local' | 'layer';
  layer?: EnvironmentStackLayer;
};

/**
 * Resolve `stack publish <arg>`: an existing file/dir is a local Stack source;
 * otherwise resolve against active `main` Stack layers. Republishing a layer
 * that itself came from a public Stack is refused in V0.
 */
export const resolvePublishSource = async (options: {
  stackHome: string;
  input: string;
}): Promise<PublishSource> => {
  if (await pathExists(options.input)) {
    const loaded = await loadLocalStack(options.input);
    return { version: loaded.version, origin: 'local' };
  }
  const current = await loadMainEnvironment({ stackHome: options.stackHome });
  const matches = current.manifest.stacks.filter(
    (layer) =>
      layer.id === options.input ||
      layer.stackId === options.input ||
      layer.name === options.input,
  );
  if (matches.length === 0)
    throw new StackCompositionError(
      'publish-source-not-found',
      `No local Stack source or active Stack layer matches ${options.input}.`,
    );
  if (matches.length > 1)
    throw new StackCompositionError(
      'publish-source-ambiguous',
      `Multiple active Stacks match ${options.input}.`,
    );
  const layer = matches[0];
  if (!layer)
    throw new StackCompositionError(
      'publish-source-not-found',
      `No active Stack matches ${options.input}.`,
    );
  if (layer.source?.kind === 'public')
    throw new StackCompositionError(
      'publish-remote-imported',
      `${layer.name} was imported from ${layer.source.ref}. Republishing an imported public Stack is not supported yet; publish your own local authoring Stack instead.`,
    );
  const version = await loadImportedVersion(options.stackHome, layer);
  return { version, origin: 'layer', layer };
};
