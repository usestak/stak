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
 * Hybrid Public Skill Portability (snapshot-first publication): EVERY requirement — whether
 * locally Git-backed (`restoration.strategy === 'reference'`) or local/imported/no-Git
 * (`'snapshot'`) — now publishes through its immutable content snapshot. The public
 * restoration is always `{ strategy: 'snapshot', contentHash }`, using the requirement's own
 * top-level `contentHash` (never a machine-local `snapshotId`, which never leaves this
 * process). A consumer of a NEW publication is therefore always self-contained: it never
 * needs the original Git repository to remain reachable, even for a Git-backed Skill.
 *
 * Git provenance for a Git-backed Skill is NOT lost — it's preserved exactly where the
 * existing public metadata model already supports it: `preferredSource`/`observedSources`
 * (unconditionally carried through below) already retain the `type: 'git'` remote/revision/
 * path. Provenance is display/update-check metadata, never a restoration dependency, so its
 * presence must never cause the restoration strategy to fall back to `'reference'`.
 *
 * The source-remote safety check (no credentials, no loopback/local remotes) now runs over
 * every git-typed `preferredSource`/`observedSources` entry on every requirement, not only
 * ones with a `'reference'` restoration — those entries are published regardless of
 * restoration strategy, so they're exactly where an unsafe remote could still leak.
 *
 * This function stays pure/no-I/O: it does NOT upload anything — the server's
 * `publishPublicStackVersion` (the one place every publish path converges, including this
 * CLI path's HTTP call) is the single place that validates/uploads each snapshot-backed
 * requirement's bytes into the public namespace, rejecting with an actionable
 * "run `stak push` first" error if the owner hasn't pushed that content yet. Legacy bundles
 * published before this change — real stored rows with `restoration.strategy === 'reference'`
 * — are untouched by this function and keep resolving through `publicBundleToImportedVersion`'s
 * existing reference pass-through.
 */
export const buildPublicStackBundle = (
  version: ImportedStackVersion,
): PublicStackBundle => {
  const unsafe: string[] = [];
  const requirements: PublicStackRequirement[] = version.requirements.map(
    (requirement) => {
      const restoration: PublicStackRequirement['restoration'] = {
        strategy: 'snapshot',
        contentHash: requirement.contentHash,
      };
      const gitSources = [
        requirement.preferredSource,
        ...requirement.observedSources,
      ].filter((source) => source?.type === 'git' && source.remote);
      for (const source of gitSources) {
        // Narrowed by the filter above, but TS can't see through it.
        if (source?.type !== 'git' || !source.remote) continue;
        const verdict = inspectPublicSourceRemote(source.remote);
        if (!verdict.safe) {
          unsafe.push(`${requirement.name} (${verdict.reason})`);
          break;
        }
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
