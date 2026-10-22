import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { memoryManifestSchema, toManifestItem } from '../domain.js';
import { writeMemoryManifest, writeMemoryObject, hashBytes } from '../store.js';
import { readCanonicalMain } from './store.js';
import { migrateLocalStore } from './migrate.js';

let stackHome: string;
beforeEach(async () => {
  stackHome = await mkdtemp(path.join(tmpdir(), 'stak-migrate-'));
});
afterEach(async () => rm(stackHome, { recursive: true, force: true }));

const putObject = async (bytes: Buffer) => {
  const contentHash = hashBytes(bytes);
  await writeMemoryObject({ stackHome, contentHash, bytes });
  return contentHash;
};

describe('migrateLocalStore', () => {
  it('converts a project auto-memory item into canonical notes/, and leaves global items in current.json', async () => {
    const autoHash = await putObject(Buffer.from('hello'));
    const globalHash = await putObject(Buffer.from('global instructions'));
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-20T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/widgets/MEMORY.md',
            project: { kind: 'git', canonical: 'github.com/acme/widgets', host: 'github.com', owner: 'acme', repo: 'widgets' },
            contentHash: autoHash,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'MEMORY.md' },
            capturedAt: '2026-10-20T00:00:00.000Z',
            sensitivity: 'private',
          },
          {
            provider: 'claude',
            kind: 'user-instructions',
            scope: 'global',
            logicalId: 'claude/user-instructions/global/CLAUDE.md',
            contentHash: globalHash,
            restoreTarget: { base: 'claude-home', relativePath: 'CLAUDE.md' },
            capturedAt: '2026-10-20T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });

    const summary = await migrateLocalStore(stackHome);
    expect(summary.alreadyMigrated).toBe(false);
    expect(summary.migratedDocuments).toBe(1);

    const main = await readCanonicalMain(stackHome);
    const doc = main.projects[0]?.documents.find((d) => d.path === 'notes/MEMORY.md');
    expect(doc).toMatchObject({ state: 'present', contentHash: autoHash });

    const current = memoryManifestSchema.parse(
      JSON.parse(await readFile(path.join(stackHome, 'memory', 'manifests', 'current.json'), 'utf8')),
    );
    expect(current.items).toHaveLength(1);
    expect(current.items[0]?.kind).toBe('user-instructions');

    const backupRaw = await readFile(
      path.join(stackHome, 'memory', 'manifests', 'current.v1-premigration.json'),
      'utf8',
    );
    expect(JSON.parse(backupRaw).items).toHaveLength(2);
  });

  it('is idempotent: running twice does not change the result or re-create the backup', async () => {
    const hash = await putObject(Buffer.from('x'));
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-20T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'project-private-instructions',
            scope: 'project',
            logicalId: 'claude/project-private/github.com/acme/widgets/CLAUDE.local.md',
            project: { kind: 'git', canonical: 'github.com/acme/widgets', host: 'github.com', owner: 'acme', repo: 'widgets' },
            contentHash: hash,
            restoreTarget: { base: 'project', relativePath: 'CLAUDE.local.md' },
            capturedAt: '2026-10-20T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });

    const first = await migrateLocalStore(stackHome);
    const backupBefore = await readFile(
      path.join(stackHome, 'memory', 'manifests', 'current.v1-premigration.json'),
      'utf8',
    );
    const second = await migrateLocalStore(stackHome);
    expect(second.alreadyMigrated).toBe(true);
    const backupAfter = await readFile(
      path.join(stackHome, 'memory', 'manifests', 'current.v1-premigration.json'),
      'utf8',
    );
    expect(backupAfter).toBe(backupBefore);
    expect(first.migratedDocuments).toBe(second.migratedDocuments);
  });

  it('seeds the claude projection file so P = C for every migrated document', async () => {
    const hash = await putObject(Buffer.from('seed me'));
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-20T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/widgets/a.md',
            project: { kind: 'git', canonical: 'github.com/acme/widgets', host: 'github.com', owner: 'acme', repo: 'widgets' },
            contentHash: hash,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
            capturedAt: '2026-10-20T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    await migrateLocalStore(stackHome);
    const { readProjection } = await import('./store.js');
    const main = await readCanonicalMain(stackHome);
    const projectId = main.projects[0]!.projectId;
    const projection = await readProjection(stackHome, 'claude');
    expect(projection.projects[projectId]?.['notes/a.md']).toBe(hash);
  });

  it('resumes correctly when interrupted after the backup but before main.json', async () => {
    const hash = await putObject(Buffer.from('resume me'));
    const manifest = {
      schemaVersion: 1 as const,
      provider: 'claude' as const,
      createdAt: '2026-10-20T00:00:00.000Z',
      items: [
        {
          provider: 'claude' as const,
          kind: 'auto-memory' as const,
          scope: 'project' as const,
          logicalId: 'claude/auto-memory/github.com/acme/widgets/a.md',
          project: { kind: 'git' as const, canonical: 'github.com/acme/widgets', host: 'github.com', owner: 'acme', repo: 'widgets' },
          contentHash: hash,
          restoreTarget: { base: 'claude-project-memory' as const, relativePath: 'a.md' },
          capturedAt: '2026-10-20T00:00:00.000Z',
          sensitivity: 'private' as const,
        },
      ],
    };
    await writeMemoryManifest({ stackHome, manifest });
    // Simulate "crashed after backup, before main.json": write the backup file by
    // hand exactly as migrateLocalStore's first step would, then call migrate.
    await writeFile(
      path.join(stackHome, 'memory', 'manifests', 'current.v1-premigration.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx' },
    );
    const summary = await migrateLocalStore(stackHome);
    expect(summary.migratedDocuments).toBe(1);
    const main = await readCanonicalMain(stackHome);
    expect(main.projects).toHaveLength(1);
  });

  it('keeps differing migration duplicates under both paths deterministically', async () => {
    const hashOld = await putObject(Buffer.from('old content'));
    const hashNew = await putObject(Buffer.from('new content'));
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-20T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/local:key-old/a.md',
            project: { kind: 'local', vendorKey: 'key-old' },
            contentHash: hashOld,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
            capturedAt: '2026-10-19T00:00:00.000Z',
            sensitivity: 'private',
          },
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/local:key-new/a.md',
            project: { kind: 'local', vendorKey: 'key-new' },
            contentHash: hashNew,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
            capturedAt: '2026-10-21T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    const summary = await migrateLocalStore(stackHome);
    expect(summary.keptBothDuplicates).toBe(1);
    const main = await readCanonicalMain(stackHome);
    const paths = main.projects.flatMap((p) => p.documents.map((d) => d.path));
    expect(paths).toContain('notes/a.md'); // latest capturedAt keeps the original path
    expect(paths.some((p) => p.startsWith('notes/a.conflict-'))).toBe(true);
  });
});
