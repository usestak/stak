import { describe, expect, it } from 'vitest';

import {
  cloudEnvironmentBundleSchema,
  deriveContentUploadRequirements,
} from './cloud.js';

const skillA = {
  name: 'alpha',
  description: 'alpha skill',
  contentHash: `sha256:${'a'.repeat(64)}`,
  observedSources: [],
  restoration: {
    strategy: 'snapshot' as const,
    contentHash: `sha256:${'a'.repeat(64)}`,
    reason: 'local' as const,
  },
};
const resolved = { schemaVersion: 1 as const, skills: { skill_aaaaaaaa: skillA } };
const importedStackVersions: never[] = [];
const environment = {
  schemaVersion: 1 as const,
  name: 'main',
  skills: [{ id: 'skill_aaaaaaaa', name: 'alpha', requirement: 'required' as const }],
  stacks: [],
  overrides: {},
};
const digest = `sha256:${'b'.repeat(64)}`;

describe('cloudEnvironmentBundleSchema — legacy bundle compatibility', () => {
  it('parses a current bundle with contentUploadRequirements unchanged', () => {
    const parsed = cloudEnvironmentBundleSchema.parse({
      schemaVersion: 1,
      environment,
      resolved,
      importedStackVersions,
      contentUploadRequirements: [{ contentHash: skillA.contentHash }],
      digest,
    });
    expect(parsed.contentUploadRequirements).toEqual([
      { contentHash: skillA.contentHash },
    ]);
  });

  it('parses an old bundle with the field entirely absent, deriving it from resolved', () => {
    const legacy = {
      schemaVersion: 1,
      environment,
      resolved,
      importedStackVersions,
      digest,
      // No contentUploadRequirements at all — the shape before it was introduced.
    };
    const parsed = cloudEnvironmentBundleSchema.parse(legacy);
    expect(parsed.contentUploadRequirements).toEqual(
      deriveContentUploadRequirements(resolved, importedStackVersions),
    );
    expect(parsed.contentUploadRequirements).toEqual([
      { contentHash: skillA.contentHash },
    ]);
  });

  it('parses the EXACT historical production shape (pre-eec8c26): snapshotRequirements with a reason field, no contentUploadRequirements', () => {
    // Derived from git history, not invented from memory: `git show eec8c26 --
    // packages/spec/src/cloud.ts` shows the bundle field was literally named
    // `snapshotRequirements: z.array({ contentHash, reason: snapshotReasonSchema })`
    // before being renamed/reshaped to `contentUploadRequirements: { contentHash }`.
    // This is the exact shape a pre-rename CLI release persisted to STAK Cloud.
    const legacyProductionShape = {
      schemaVersion: 1,
      environment,
      resolved,
      importedStackVersions,
      snapshotRequirements: [{ contentHash: skillA.contentHash, reason: 'local' }],
      digest,
    };
    const parsed = cloudEnvironmentBundleSchema.parse(legacyProductionShape);
    // The old `reason` tag carries no information current consumers need (every
    // resolved Skill's content is uploaded regardless of reason since eec8c26) —
    // dropping it and deriving fresh is correct, not a data loss.
    expect(parsed.contentUploadRequirements).toEqual([
      { contentHash: skillA.contentHash },
    ]);
  });

  it('still fails closed on a genuinely malformed bundle (missing resolved entirely)', () => {
    expect(() =>
      cloudEnvironmentBundleSchema.parse({
        schemaVersion: 1,
        environment,
        importedStackVersions,
        digest,
      }),
    ).toThrow();
  });

  it('still fails closed on a genuinely malformed bundle (wrong schemaVersion)', () => {
    expect(() =>
      cloudEnvironmentBundleSchema.parse({
        schemaVersion: 2,
        environment,
        resolved,
        importedStackVersions,
        contentUploadRequirements: [],
        digest,
      }),
    ).toThrow();
  });
});

describe('deriveContentUploadRequirements', () => {
  it('is sorted and deduplicated by content hash', () => {
    const dupedResolved = {
      schemaVersion: 1 as const,
      skills: {
        skill_aaaaaaaa: skillA,
        skill_bbbbbbbb: { ...skillA, name: 'alpha-copy' }, // same contentHash
      },
    };
    const result = deriveContentUploadRequirements(dupedResolved, []);
    expect(result).toEqual([{ contentHash: skillA.contentHash }]);
  });
});
