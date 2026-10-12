import { importedStackVersionSchema } from '@stack/spec';
import type { ImportedStackVersion, ReferenceRecord } from '@stack/spec';
import type { UserStackClient } from '@stack/cloud-client';

import { StackCompositionError } from './stack-loader.js';
import { stackVersionHash } from './stack-loader.js';

export type ResolvedOwnedStackSource = {
  stackId: string;
  name: string;
  versionHash: string;
  version: ImportedStackVersion;
  references: Map<string, ReferenceRecord>;
};

/**
 * Fetch the caller's own named Stack `<name>` from Cloud (P10B §14) and produce a local
 * imported version plus the exact Git references needed to reacquire its Skills — the
 * owned-Stack analog of {@link resolvePublicStackSource}. This is the user's own account
 * data (not untrusted public input), but the shape is still validated via the response
 * schema the client already parses against.
 */
export const resolveOwnedStackSource = async (options: {
  client: Pick<UserStackClient, 'getUserStack'>;
  name: string;
}): Promise<ResolvedOwnedStackSource> => {
  const response = await options.client.getUserStack(options.name);
  if (!response)
    throw new StackCompositionError(
      'owned-stack-not-found',
      `No Cloud Stack named "${options.name}".`,
    );
  const requirements = response.bundle.skills.map((skill) => ({
    id: `req_${skill.skillId.replace(/^skill_/, '')}`,
    name: skill.name,
    requirement: 'required' as const,
    contentHash: skill.contentHash,
    metadata: skill.metadata,
    // Cloud's portable snapshot restoration carries a contentHash, never a local snapshotId
    // (Cloud never holds snapshot content). The local shape requires a snapshotId field to
    // parse, but nothing in this apply path ever dereferences it — restoration always goes
    // through `contentHash`-keyed Store lookups (`verifyStoredSkill`). This id is a
    // deterministic, inert placeholder, never a real snapshot-storage key.
    restoration:
      skill.restoration.strategy === 'reference'
        ? skill.restoration
        : {
            strategy: 'snapshot' as const,
            snapshotId: `snap_${skill.skillId.replace(/^skill_/, '')}`,
            reason: skill.restoration.reason,
          },
    observedSources: skill.observedSources,
    ...(skill.preferredSource
      ? { preferredSource: skill.preferredSource }
      : {}),
    originStackName: response.bundle.name,
  }));
  // ImportedStackVersion requires a non-empty description; a named Stack's own description
  // is optional (spec), so fall back to its (always non-empty) name rather than fabricate text.
  const description = response.bundle.description || response.bundle.name;
  const versionHash = stackVersionHash({
    name: response.bundle.name,
    description,
    requirements,
    inheritedStacks: [],
    skippedOptional: [],
  });
  const version = importedStackVersionSchema.parse({
    schemaVersion: 1,
    name: response.bundle.name,
    description,
    versionHash,
    requirements,
    inheritedStacks: [],
    skippedOptional: [],
  });
  const references = new Map<string, ReferenceRecord>();
  for (const requirement of requirements)
    if (requirement.restoration.strategy === 'reference')
      references.set(requirement.id, requirement.restoration.reference);
  return {
    stackId: response.stackId,
    name: response.name,
    versionHash,
    version,
    references,
  };
};
