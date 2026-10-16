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
  PublicStackRequirement,
} from '@stack/spec';
import { sha256CanonicalJson } from '@stack/shared';
import { PublicationNotEligibleError } from '@stack/cloud-client';

import { loadLocalStack, StackCompositionError } from './stack-loader.js';
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
 * Build a public Stack bundle from a resolved imported version.
 *
 * Hybrid Public Skill Portability: a Git-reference-backed Skill keeps publishing its
 * reference unchanged (still subject to the source-remote safety check below); a
 * snapshot-backed Skill (local/imported/no-Git) is now portable through its immutable
 * content snapshot (`contentHash` only — no owner-local `snapshotId` ever leaves this
 * process). This function stays pure/no-I/O: it does NOT upload anything — the server's
 * `publishPublicStackVersion` (the one place every publish path converges, including this
 * CLI path's HTTP call) is the single place that validates/uploads each snapshot-backed
 * requirement's bytes into the public namespace, rejecting with an actionable
 * "run `stak push` first" error if the owner hasn't pushed that content yet.
 */
export const buildPublicStackBundle = (
  version: ImportedStackVersion,
): PublicStackBundle => {
  const unsafe: string[] = [];
  const requirements: PublicStackRequirement[] = version.requirements.map(
    (requirement) => {
      const { restoration: localRestoration } = requirement;
      // Local `restoration.snapshot` carries only a machine-local `snapshotId` (storage.ts) —
      // the portable identity is the requirement's own top-level `contentHash`, already the
      // same content-addressed hash the owner's `stak push` uploaded under.
      const restoration: PublicStackRequirement['restoration'] =
        localRestoration.strategy === 'snapshot'
          ? { strategy: 'snapshot', contentHash: requirement.contentHash }
          : localRestoration;
      if (localRestoration.strategy === 'reference') {
        const verdict = inspectPublicSourceRemote(
          localRestoration.reference.remote,
        );
        if (!verdict.safe)
          unsafe.push(`${requirement.name} (${verdict.reason})`);
      }
      return {
        id: requirement.id,
        name: requirement.name,
        requirement: requirement.requirement,
        contentHash: requirement.contentHash,
        metadata: requirement.metadata,
        restoration,
        observedSources: requirement.observedSources,
        ...(requirement.preferredSource
          ? { preferredSource: requirement.preferredSource }
          : {}),
        originStackName: requirement.originStackName,
      };
    },
  );
  if (unsafe.length > 0)
    throw new PublicationNotEligibleError(
      `Cannot publish ${version.name}. Unsafe public source references: ${unsafe.join(', ')}.`,
    );

  const inheritedStackMetadata = version.inheritedStacks;
  // Deterministic, path-free public version hash over the public content only
  // (skipped-optional authoring diagnostics are excluded to avoid leaking paths). Uses
  // `sha256CanonicalJson` directly (not `stackVersionHash`, which is typed for the LOCAL
  // `ImportedStackVersion` requirement shape) because the public requirements array now
  // carries the public (contentHash-only) snapshot restoration shape, not the local
  // (snapshotId) one — both helpers hash with the identical canonical-JSON + sha256
  // algorithm, so this remains byte-identical to what a pure-reference bundle hashed to
  // before, and byte-identical to the server's own `sha256CanonicalJson` computation.
  const versionHash = sha256CanonicalJson({
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
    kind: 'stack' as const,
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
