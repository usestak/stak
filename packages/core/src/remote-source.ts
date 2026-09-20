import { importedStackVersionSchema, parsePublicStackRef } from '@stack/spec';
import type {
  ImportedStackVersion,
  PublicStackBundle,
  ReferenceRecord,
} from '@stack/spec';
import { sha256CanonicalJson } from '@stack/shared';
import {
  CloudBundleInvalidError,
  PublicStackNotFoundError,
  type PublicStackClient,
} from '@stack/cloud-client';

import { publicBundleDigestInput } from './public-stack.js';
import { stackVersionHash } from './stack-loader.js';

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
    restoration: requirement.restoration,
    observedSources: requirement.observedSources,
    ...(requirement.preferredSource
      ? { preferredSource: requirement.preferredSource }
      : {}),
    originStackName: requirement.originStackName,
  }));
  const expectedVersionHash = stackVersionHash({
    name: bundle.stack.name,
    description: bundle.stack.description,
    requirements,
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
  versionHash: string;
  version: ImportedStackVersion;
  references: Map<string, ReferenceRecord>;
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
  const references = new Map<string, ReferenceRecord>(
    bundle.requirements.map((requirement) => [
      requirement.id,
      requirement.restoration.reference,
    ]),
  );
  return {
    ref: `@${parsed.owner}/${parsed.slug}`,
    owner: parsed.owner,
    slug: parsed.slug,
    publicStackId: response.stackId,
    publicVersionId: response.latest.version.versionId,
    versionHash: bundle.stack.versionHash,
    version,
    references,
  };
};
