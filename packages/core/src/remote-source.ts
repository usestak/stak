import { importedStackVersionSchema, parsePublicStackRef } from '@stack/spec';
import type {
  ImportedStackVersion,
  PublicStackBundle,
  PublicStackRequirement,
} from '@stack/spec';
import { sha256CanonicalJson } from '@stack/shared';
import {
  CloudBundleInvalidError,
  PublicStackNotFoundError,
  type PublicStackClient,
} from '@stack/cloud-client';

import { publicBundleDigestInput } from './public-stack.js';

/** Convert a verified public bundle into a local imported Stack version. */
export const publicBundleToImportedVersion = (
  bundle: PublicStackBundle,
): ImportedStackVersion => {
  const requirements = bundle.requirements.map((requirement) => ({
    id: requirement.id,
    name: requirement.name,
    requirement: requirement.requirement,
    contentHash: requirement.contentHash,
    metadata: requirement.metadata,
    // Hybrid Public Skill Portability: the public bundle's snapshot restoration carries only
    // a contentHash (Cloud never holds snapshot content under a local id). The local
    // `ImportedStackVersion` shape requires a `snapshotId` to parse, but nothing in the
    // use/try apply path ever dereferences it — restoration always goes through
    // `contentHash`-keyed Store lookups (`verifyStoredSkill`) and the bundle's own
    // `restorations` map (built in `resolvePublicStackSource` below). This id is a
    // deterministic, inert placeholder, never a real snapshot-storage key — same pattern
    // `resolveOwnedStackSource` already uses for the owned-Stack analog of this conversion.
    restoration:
      requirement.restoration.strategy === 'reference'
        ? requirement.restoration
        : {
            strategy: 'snapshot' as const,
            snapshotId: `snap_${requirement.id.replace(/^req_/, '')}`,
            reason: 'local' as const,
          },
    observedSources: requirement.observedSources,
    ...(requirement.preferredSource
      ? { preferredSource: requirement.preferredSource }
      : {}),
    originStackName: requirement.originStackName,
  }));
  // Recomputed over the PUBLIC-shaped `bundle.requirements` (contentHash-only snapshot
  // restoration), not the locally-converted `requirements` above (which carries an inert
  // placeholder snapshotId) — the server hashed the public shape, so verification must use
  // the exact same input `sha256CanonicalJson` the server/`buildPublicStackBundle` both use,
  // not `stackVersionHash` (typed and intended for the local requirement shape).
  const expectedVersionHash = sha256CanonicalJson({
    name: bundle.stack.name,
    description: bundle.stack.description,
    requirements: bundle.requirements,
    inheritedStacks: bundle.inheritedStackMetadata,
    skippedOptional: [],
  });
  if (expectedVersionHash !== bundle.stack.versionHash)
    throw new CloudBundleInvalidError(
      'Public Stack version hash does not match its contents.',
    );
  return importedStackVersionSchema.parse({
    schemaVersion: 1,
    name: bundle.stack.name,
    description: bundle.stack.description,
    versionHash: bundle.stack.versionHash,
    requirements,
    inheritedStacks: bundle.inheritedStackMetadata,
    skippedOptional: [],
  });
};

export type ResolvedPublicStackSource = {
  ref: string;
  owner: string;
  slug: string;
  publicStackId: string;
  publicVersionId: string;
  versionNumber: number;
  versionHash: string;
  version: ImportedStackVersion;
  // Hybrid Public Skill Portability: per-requirement restoration straight from the PUBLIC
  // bundle (not the derived local `version`, whose snapshot variant carries only an inert
  // placeholder id) — the apply path branches on `.strategy` here to decide between a Git
  // reference restore and a public-snapshot fetch+verify+extract.
  restorations: Map<string, PublicStackRequirement['restoration']>;
};

/**
 * Fetch the latest public version for `@owner/name`, validate its digest and
 * version hash (untrusted input), and produce a local imported version plus the
 * exact Git references needed to reacquire its Skills.
 */
export const resolvePublicStackSource = async (options: {
  client: Pick<PublicStackClient, 'getPublicStack'>;
  ref: string;
}): Promise<ResolvedPublicStackSource> => {
  const parsed = parsePublicStackRef(options.ref);
  const response = await options.client.getPublicStack(
    parsed.owner,
    parsed.slug,
  );
  if (!response)
    throw new PublicStackNotFoundError(
      `No public Stack @${parsed.owner}/${parsed.slug}.`,
    );
  if (!response.latest)
    throw new PublicStackNotFoundError(
      `@${parsed.owner}/${parsed.slug} has no published versions.`,
    );
  const bundle = response.latest.bundle;
  if (sha256CanonicalJson(publicBundleDigestInput(bundle)) !== bundle.digest)
    throw new CloudBundleInvalidError(
      'Public Stack bundle digest does not match its contents.',
    );
  const version = publicBundleToImportedVersion(bundle);
  const restorations = new Map<string, PublicStackRequirement['restoration']>(
    bundle.requirements.map((requirement) => [
      requirement.id,
      requirement.restoration,
    ]),
  );
  return {
    ref: `@${parsed.owner}/${parsed.slug}`,
    owner: parsed.owner,
    slug: parsed.slug,
    publicStackId: response.stackId,
    publicVersionId: response.latest.version.versionId,
    versionNumber: response.latest.version.versionNumber,
    versionHash: bundle.stack.versionHash,
    version,
    restorations,
  };
};
