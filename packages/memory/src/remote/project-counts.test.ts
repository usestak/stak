import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashBytes, writeMemoryManifest, writeMemoryObject } from '../store.js';
import { writePortableSnapshot } from '../project/registry-store.js';
import type { ManifestItem } from '../domain.js';
import { writeCanonicalMain } from '../canonical/store.js';
import { CANONICAL_MAIN_SCHEMA_VERSION } from '../canonical/domain.js';
import { bundleFromStore } from './bundle-codec.js';
import { standardProjectCountsFromBundle } from './project-counts.js';

const dirs: string[] = [];
const temp = async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'stak-pcounts-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

const PRJ_A = `prj_${'a'.repeat(26)}`;
const PRJ_B = `prj_${'b'.repeat(26)}`;

const gitItem = (
  canonical: string,
  rel: string,
  body: string,
): ManifestItem => {
  const bytes = Buffer.from(body, 'utf8');
  const [host, owner, repo] = canonical.split('/');
  return {
    provider: 'claude',
    kind: 'auto-memory',
    scope: 'project',
    logicalId: `claude/auto-memory/${canonical}/${rel}`,
    project: {
      kind: 'git',
      canonical,
      host: host ?? '',
      owner: owner ?? '',
      repo: repo ?? '',
    },
    contentHash: hashBytes(bytes),
    restoreTarget: { base: 'claude-project-memory', relativePath: rel },
    capturedAt: '2026-10-05T00:00:00.000Z',
    sensitivity: 'private',
  };
};

const seedStandardBundle = async (): Promise<Uint8Array> => {
  const stackHome = await temp();
  const bodies: [ManifestItem, string][] = [
    [gitItem('github.com/acme/atlas', 'a1.md', 'ALPHA-BODY'), 'ALPHA-BODY'],
    [gitItem('github.com/acme/atlas', 'a2.md', 'BETA-BODY'), 'BETA-BODY'],
    [gitItem('github.com/acme/beta', 'b1.md', 'GAMMA-BODY'), 'GAMMA-BODY'],
  ];
  for (const [item, body] of bodies)
    await writeMemoryObject({
      stackHome,
      contentHash: item.contentHash,
      bytes: Buffer.from(body, 'utf8'),
    });
  await writeMemoryManifest({
    stackHome,
    manifest: {
      schemaVersion: 1,
      provider: 'claude',
      createdAt: '2026-10-05T00:00:00.000Z',
      items: bodies.map(([item]) => item),
    },
  });
  await writePortableSnapshot(stackHome, {
    snapshotVersion: 1,
    projects: [
      {
        projectId: PRJ_A,
        claims: [{ type: 'git', canonical: 'github.com/acme/atlas' }],
      },
      {
        projectId: PRJ_B,
        claims: [{ type: 'git', canonical: 'github.com/acme/beta' }],
      },
    ],
  });
  return (await bundleFromStore(stackHome)).bytes;
};

describe('standardProjectCountsFromBundle (P3 §2)', () => {
  it('A. groups a multi-project Standard bundle by stable Project ID', async () => {
    const counts = standardProjectCountsFromBundle(await seedStandardBundle());
    expect(counts).toEqual([
      { projectId: PRJ_A, fileCount: 2 },
      { projectId: PRJ_B, fileCount: 1 },
    ]);
  });

  it('B+C. exposes no Memory body content and no paths', async () => {
    const serialized = JSON.stringify(
      standardProjectCountsFromBundle(await seedStandardBundle()),
    );
    for (const body of ['ALPHA-BODY', 'BETA-BODY', 'GAMMA-BODY'])
      expect(serialized).not.toContain(body);
    expect(serialized).not.toMatch(/\/Users\/|[A-Za-z]:\\\\|~\//);
  });

  it('D. a malformed bundle fails safe (null), never leaking content', () => {
    expect(
      standardProjectCountsFromBundle(new Uint8Array([1, 2, 3])),
    ).toBeNull();
    expect(
      standardProjectCountsFromBundle(Buffer.from('not a bundle', 'utf8')),
    ).toBeNull();
  });

  it('counts present documents per project from a v2 bundle, ignoring tombstones', async () => {
    const stackHome = await temp();
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-22T00:00:00.000Z',
        items: [],
      },
    });
    await writeCanonicalMain(stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        {
          projectId: PRJ_A,
          documents: [
            {
              path: 'notes/a.md',
              state: 'present',
              contentHash: `sha256:${'1'.repeat(64)}`,
              importedFrom: 'claude',
              importedAt: '2026-10-22T00:00:00.000Z',
            },
            {
              path: 'notes/b.md',
              state: 'deleted',
              lastContentHash: `sha256:${'2'.repeat(64)}`,
              deletedAt: '2026-10-22T00:00:00.000Z',
            },
          ],
        },
      ],
    });
    const { bytes } = await bundleFromStore(stackHome);
    expect(standardProjectCountsFromBundle(bytes)).toEqual([
      { projectId: PRJ_A, fileCount: 1 },
    ]);
  });
});
