import { describe, expect, it } from 'vitest';
import {
  CANONICAL_MAIN_SCHEMA_VERSION,
  canonicalDigest,
  canonicalMainManifestSchema,
  type CanonicalMainManifest,
} from './domain.js';

const sha = (n: number) => `sha256:${n.toString().padStart(64, '0')}`;

describe('canonicalMainManifestSchema', () => {
  it('accepts a present document and a tombstone', () => {
    const main = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        {
          projectId: 'prj_00000000000000000000000000',
          documents: [
            {
              path: 'notes/a.md',
              state: 'present',
              contentHash: sha(1),
              importedFrom: 'claude',
              importedAt: '2026-10-22T00:00:00.000Z',
            },
            {
              path: 'notes/b.md',
              state: 'deleted',
              lastContentHash: sha(2),
              deletedAt: '2026-10-22T00:00:00.000Z',
            },
          ],
        },
      ],
    };
    expect(() => canonicalMainManifestSchema.parse(main)).not.toThrow();
  });

  it('rejects a document missing its state-specific fields', () => {
    const main = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        {
          projectId: 'prj_00000000000000000000000000',
          documents: [{ path: 'notes/a.md', state: 'present' }],
        },
      ],
    };
    expect(() => canonicalMainManifestSchema.parse(main)).toThrow();
  });
});

describe('canonicalDigest', () => {
  const docA: CanonicalMainManifest['projects'][0]['documents'][0] = {
    path: 'notes/a.md',
    state: 'present',
    contentHash: sha(1),
    importedFrom: 'claude',
    importedAt: '2026-10-22T00:00:00.000Z',
  };
  const docZ: CanonicalMainManifest['projects'][0]['documents'][0] = {
    path: 'notes/z.md',
    state: 'present',
    contentHash: sha(2),
    importedFrom: 'claude',
    importedAt: '2026-10-22T00:00:00.000Z',
  };

  it('is identical regardless of project/document array order', () => {
    const a: CanonicalMainManifest = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        { projectId: 'prj_b', documents: [docA] },
        { projectId: 'prj_a', documents: [docZ] },
      ],
    };
    const b: CanonicalMainManifest = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        { projectId: 'prj_a', documents: [docZ] },
        { projectId: 'prj_b', documents: [docA] },
      ],
    };
    expect(canonicalDigest(a)).toBe(canonicalDigest(b));
  });

  it('differs when a content hash differs', () => {
    const a: CanonicalMainManifest = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [{ projectId: 'prj_a', documents: [docA] }],
    };
    const b: CanonicalMainManifest = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        { projectId: 'prj_a', documents: [{ ...docA, contentHash: sha(9) }] },
      ],
    };
    expect(canonicalDigest(a)).not.toBe(canonicalDigest(b));
  });
});
