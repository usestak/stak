import { describe, expect, it } from 'vitest';

import {
  contentStoreMetadataSchema,
  referenceRestorationSchema,
  snapshotRecordSchema,
  snapshotRestorationSchema,
  storeVerificationSchema,
} from './storage.js';
import { lockedSkillSchema, skillStatusSchema } from './environment.js';

const contentHash = `sha256:${'a'.repeat(64)}`;

describe('Phase 3 storage contracts', () => {
  it('parses immutable content metadata and verification states', () => {
    expect(
      contentStoreMetadataSchema.parse({
        schemaVersion: 1,
        algorithm: 'sha256',
        contentHash,
        createdAt: '2026-09-19T12:00:00.000Z',
        kind: 'skill',
      }).contentHash,
    ).toBe(contentHash);
    for (const state of ['available', 'missing', 'corrupt'] as const)
      expect(
        storeVerificationSchema.parse({
          state,
          contentHash,
          ...(state === 'available'
            ? {}
            : { code: `object-${state}`, message: state }),
        }).state,
      ).toBe(state);
  });

  it('accepts portable Git references and rejects machine-local remotes', () => {
    const reference = {
      strategy: 'reference' as const,
      reference: {
        remote: 'git@github.com:owner/repo.git',
        revision: 'abc123',
        path: 'skills/design',
        expectedContentHash: contentHash,
      },
    };
    expect(referenceRestorationSchema.parse(reference)).toEqual(reference);
    for (const remote of [
      'C:\\repos\\one',
      '../one',
      '/repos/one',
      'file:///repo',
    ])
      expect(() =>
        referenceRestorationSchema.parse({
          ...reference,
          reference: { ...reference.reference, remote },
        }),
      ).toThrow();
  });

  it('parses local snapshot restoration records', () => {
    const snapshotId = 'snap_86526e9e-3c97-4b0f-8bcb-1a65660568cf';
    expect(
      snapshotRestorationSchema.parse({
        strategy: 'snapshot',
        snapshotId,
        reason: 'local',
      }).snapshotId,
    ).toBe(snapshotId);
    expect(
      snapshotRecordSchema.parse({
        schemaVersion: 1,
        snapshotId,
        environmentEntryId: 'skill_86526e9e-3c97-4b0f-8bcb-1a65660568cf',
        contentHash,
        createdAt: '2026-09-19T12:00:00.000Z',
        reason: 'local',
      }).contentHash,
    ).toBe(contentHash);
  });

  it('requires preservation and restoration information on locked Skills', () => {
    const legacy = {
      name: 'one',
      description: 'one',
      contentHash,
      observedSources: [{ type: 'local' as const }],
    };
    expect(() => lockedSkillSchema.parse(legacy)).toThrow();
    expect(
      lockedSkillSchema.parse({
        ...legacy,
        localContent: { available: true, contentHash },
        restoration: {
          strategy: 'snapshot',
          snapshotId: 'snap_86526e9e-3c97-4b0f-8bcb-1a65660568cf',
          reason: 'local',
        },
      }).restoration.strategy,
    ).toBe('snapshot');
  });

  it('requires independent preservation status for desired Skills', () => {
    const status = {
      entryId: 'skill_86526e9e-3c97-4b0f-8bcb-1a65660568cf',
      name: 'one',
      state: 'satisfied' as const,
      desiredHash: contentHash,
      baselineLocations: [],
      currentLocations: [],
      uncertaintyRoots: [],
    };
    expect(() => skillStatusSchema.parse(status)).toThrow();
    expect(
      skillStatusSchema.parse({
        ...status,
        preservation: { state: 'available', contentHash },
        restorationStrategy: 'snapshot',
      }).preservation.state,
    ).toBe('available');
  });
});
