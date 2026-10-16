import { describe, expect, it } from 'vitest';

import { sha256CanonicalJson } from '@stack/shared';
import { importedStackVersionSchema } from '@stack/spec';
import type { ImportedStackVersion, SkillSource } from '@stack/spec';
import {
  CloudBundleInvalidError,
  PublicationNotEligibleError,
} from '@stack/cloud-client';

import {
  buildPublicStackBundle,
  publicBundleDigestInput,
} from './public-stack.js';
import { publicBundleToImportedVersion } from './remote-source.js';
import { stackVersionHash } from './stack-loader.js';

const hash = (char: string) => `sha256:${char.repeat(64)}`;
const revision = 'a'.repeat(40);

const gitSource = (remote: string): SkillSource => ({
  type: 'git',
  remote,
  revision,
  path: 'skills/design',
  clean: true,
});

const referenceVersion = (
  remote = 'https://github.com/example/design.git',
): ImportedStackVersion => {
  const contentHash = hash('a');
  const requirements = [
    {
      id: 'req_aaaaaaaa',
      name: 'design',
      requirement: 'required' as const,
      contentHash,
      metadata: { name: 'design', description: 'Design engineering' },
      restoration: {
        strategy: 'reference' as const,
        reference: {
          remote,
          revision,
          path: 'skills/design',
          expectedContentHash: contentHash,
        },
      },
      observedSources: [gitSource(remote)],
      preferredSource: gitSource(remote),
      originStackName: 'frontend',
    },
  ];
  return importedStackVersionSchema.parse({
    schemaVersion: 1,
    name: 'frontend',
    description: 'Frontend Stack',
    versionHash: stackVersionHash({
      name: 'frontend',
      description: 'Frontend Stack',
      requirements,
      inheritedStacks: [],
      skippedOptional: [],
    }),
    requirements,
    inheritedStacks: [],
    skippedOptional: [],
  });
};

describe('buildPublicStackBundle', () => {
  it('snapshots a Git-backed Skill (snapshot-first publication) while preserving Git provenance as metadata', () => {
    const remote = 'https://github.com/example/design.git';
    const version = referenceVersion(remote);
    const contentHash = version.requirements[0]?.contentHash;
    const bundle = buildPublicStackBundle(version);
    expect(bundle.requirements).toHaveLength(1);
    // A Git-backed Skill now publishes through its immutable snapshot, not a Git reference —
    // a consumer of this NEW publication never needs the original repository.
    expect(bundle.requirements[0]?.restoration).toEqual({
      strategy: 'snapshot',
      contentHash,
    });
    // Git provenance is NOT discarded: it's retained as display/update-check metadata on
    // `preferredSource`/`observedSources`, exactly as before.
    expect(bundle.requirements[0]?.preferredSource).toEqual(gitSource(remote));
    expect(bundle.requirements[0]?.observedSources).toEqual([
      gitSource(remote),
    ]);
    expect(sha256CanonicalJson(publicBundleDigestInput(bundle))).toBe(
      bundle.digest,
    );
    // Public version hash is deterministic over public content. Uses
    // `sha256CanonicalJson` directly (not `stackVersionHash`, which is typed for the
    // LOCAL requirement shape) since `bundle.requirements` is now public-shaped.
    expect(bundle.stack.versionHash).toBe(
      sha256CanonicalJson({
        name: 'frontend',
        description: 'Frontend Stack',
        requirements: bundle.requirements,
        inheritedStacks: [],
        skippedOptional: [],
      }),
    );
  });

  it('Hybrid Public Skill Portability: builds a snapshot-restoration bundle for snapshot-backed (no-Git) Skills instead of blocking them', () => {
    const version = referenceVersion();
    const contentHash = version.requirements[0]?.contentHash;
    const snapshotVersion: ImportedStackVersion = {
      ...version,
      requirements: version.requirements.map((requirement) => ({
        ...requirement,
        restoration: {
          strategy: 'snapshot',
          snapshotId: 'snap_aaaaaaaa',
          reason: 'local',
        },
      })),
    };
    const bundle = buildPublicStackBundle(snapshotVersion);
    expect(bundle.requirements).toHaveLength(1);
    // The public restoration carries the requirement's own content-addressed hash — the
    // local-only `snapshotId` never leaves this function.
    expect(bundle.requirements[0]?.restoration).toEqual({
      strategy: 'snapshot',
      contentHash,
    });
  });

  it('blocks credential-bearing source remotes', () => {
    expect(() =>
      buildPublicStackBundle(
        referenceVersion('https://token@github.com/example/design.git'),
      ),
    ).toThrow(PublicationNotEligibleError);
  });

  it('round-trips into an imported version with the same version hash', () => {
    const bundle = buildPublicStackBundle(referenceVersion());
    const version = publicBundleToImportedVersion(bundle);
    expect(version.versionHash).toBe(bundle.stack.versionHash);
    // Snapshot-first publication: even though the SOURCE was Git-backed, the published (and
    // round-tripped) restoration is 'snapshot' — no Git dependency survives into the bundle.
    expect(version.requirements[0]?.restoration.strategy).toBe('snapshot');
  });

  it('legacy reference-only published bundles still resolve through the Git/reference path unchanged', () => {
    // A bundle shaped exactly like one stored before snapshot-first publication existed —
    // never built via `buildPublicStackBundle` (which no longer emits this shape) —
    // simulating a real pre-existing row read back from Cloud storage.
    const remote = 'https://github.com/example/design.git';
    const contentHash = hash('b');
    const requirements = [
      {
        id: 'req_bbbbbbbb',
        name: 'design',
        requirement: 'required' as const,
        contentHash,
        metadata: { name: 'design', description: 'Design engineering' },
        restoration: {
          strategy: 'reference' as const,
          reference: {
            remote,
            revision,
            path: 'skills/design',
            expectedContentHash: contentHash,
          },
        },
        observedSources: [gitSource(remote)],
        preferredSource: gitSource(remote),
        originStackName: 'frontend',
      },
    ];
    const inheritedStackMetadata: never[] = [];
    const stack = {
      name: 'frontend',
      description: 'Frontend Stack',
      versionHash: sha256CanonicalJson({
        name: 'frontend',
        description: 'Frontend Stack',
        requirements,
        inheritedStacks: inheritedStackMetadata,
        skippedOptional: [],
      }),
      kind: 'stack' as const,
    };
    const legacyBundle = {
      schemaVersion: 1 as const,
      stack,
      requirements,
      inheritedStackMetadata,
      digest: sha256CanonicalJson(
        publicBundleDigestInput({
          stack,
          requirements,
          inheritedStackMetadata,
        }),
      ),
    };
    const version = publicBundleToImportedVersion(legacyBundle);
    expect(version.versionHash).toBe(legacyBundle.stack.versionHash);
    expect(version.requirements[0]?.restoration).toEqual(
      requirements[0]?.restoration,
    );
  });

  it('rejects a bundle whose version hash was tampered', () => {
    const bundle = buildPublicStackBundle(referenceVersion());
    expect(() =>
      publicBundleToImportedVersion({
        ...bundle,
        stack: { ...bundle.stack, versionHash: hash('f') },
      }),
    ).toThrow(CloudBundleInvalidError);
  });

  it('never serializes authoring or machine paths', () => {
    const serialized = JSON.stringify(
      buildPublicStackBundle(referenceVersion()),
    );
    for (const forbidden of ['/home/', 'C:\\\\Users', '.stack', 'snap_'])
      expect(serialized).not.toContain(forbidden);
  });
});
