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

  it('keeps differing migration duplicates under both paths deterministically — the SAME identity captured twice with different content', async () => {
    // The only SAFE "old duplicate" case: both items carry the SAME git identity
    // (same canonical remote), so they are PROVEN to be the same real project —
    // never guessed from a coincidentally-matching path. A duplicate can arise
    // here because the same project was captured at two different times, under
    // two different (now-irrelevant) vendor keys, before the content stabilized.
    const hashOld = await putObject(Buffer.from('old content'));
    const hashNew = await putObject(Buffer.from('new content'));
    const identity = {
      kind: 'git' as const,
      canonical: 'github.com/acme/widgets',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    };
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
            logicalId: 'claude/auto-memory/github.com/acme/widgets/a.md#old',
            project: identity,
            contentHash: hashOld,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
            capturedAt: '2026-10-19T00:00:00.000Z',
            sensitivity: 'private',
          },
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/widgets/a.md#new',
            project: identity,
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
    expect(main.projects).toHaveLength(1); // one real project, not two
    const paths = main.projects[0]!.documents.map((d) => d.path);
    expect(paths).toContain('notes/a.md'); // latest capturedAt keeps the original path
    expect(paths.some((p) => p.startsWith('notes/a.conflict-'))).toBe(true);
  });

  it('does NOT merge two UNRELATED local (non-Git) projects that happen to share a relative path', async () => {
    // This is the regression this fixture exists to prevent: two different real
    // local projects both having, say, `MEMORY.md` must NEVER be coalesced just
    // because the path matches. Path is never a strong identity signal (same
    // rule as everywhere else in this system) — only a PROVEN shared identity
    // (same git canonical, or the SAME already-resolved Project ID) may coalesce
    // duplicates. Two different `local` vendor keys prove nothing about being
    // the same project, so migration must mint two SEPARATE projects here, with
    // NO keep-both naming and NO cross-project data loss.
    const hashA = await putObject(Buffer.from('project A content'));
    const hashB = await putObject(Buffer.from('project B content'));
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
            logicalId: 'claude/auto-memory/local:key-foo/MEMORY.md',
            project: { kind: 'local', vendorKey: 'key-foo' },
            contentHash: hashA,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'MEMORY.md' },
            capturedAt: '2026-10-19T00:00:00.000Z',
            sensitivity: 'private',
          },
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/local:key-bar/MEMORY.md',
            project: { kind: 'local', vendorKey: 'key-bar' },
            contentHash: hashB,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'MEMORY.md' },
            capturedAt: '2026-10-21T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    const summary = await migrateLocalStore(stackHome);
    expect(summary.keptBothDuplicates).toBe(0);
    const main = await readCanonicalMain(stackHome);
    expect(main.projects).toHaveLength(2); // two separate projects, never merged
    for (const project of main.projects) {
      expect(project.documents).toHaveLength(1);
      expect(project.documents[0]!.path).toBe('notes/MEMORY.md'); // each keeps its own, unsuffixed
    }
    const hashes = main.projects.map((p) => (p.documents[0] as { contentHash: string }).contentHash).sort();
    expect(hashes).toEqual([hashA, hashB].sort());
  });

  it('throws migration-invalid for a genuinely broken entry (content missing from the store)', async () => {
    const missingHash = `sha256:${'9'.repeat(64)}`; // never written via putObject
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
            logicalId: 'claude/auto-memory/github.com/acme/widgets/broken.md',
            project: { kind: 'git', canonical: 'github.com/acme/widgets', host: 'github.com', owner: 'acme', repo: 'widgets' },
            contentHash: missingHash,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'broken.md' },
            capturedAt: '2026-10-20T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    await expect(migrateLocalStore(stackHome)).rejects.toMatchObject({ code: 'migration-invalid' });
    // Fails BEFORE any mutation: no backup side effect beyond the (harmless,
    // always-written) pre-migration backup file itself, and no canonical main.
    const main = await readCanonicalMain(stackHome);
    expect(main.projects).toEqual([]);
  });

  it('works on a genuinely fresh $STAK_HOME with no manifests directory at all yet', async () => {
    // No writeMemoryManifest call at all — `stackHome` here has never had ANY
    // memory command touch it, so `memory/manifests/` does not exist yet. This
    // is the real first-run path for every brand-new account.
    const summary = await migrateLocalStore(stackHome);
    expect(summary.migratedDocuments).toBe(0);
    expect(summary.alreadyMigrated).toBe(false);
    // Calling it again must still be a safe no-op.
    const second = await migrateLocalStore(stackHome);
    expect(second.alreadyMigrated).toBe(true);
  });

  it('is a true no-op after completion: does not revert global items backed up since, and does not reset the projection', async () => {
    const hash = await putObject(Buffer.from('global instructions v1'));
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-20T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'user-instructions',
            scope: 'global',
            logicalId: 'claude/user-instructions/global/CLAUDE.md',
            contentHash: hash,
            restoreTarget: { base: 'claude-home', relativePath: 'CLAUDE.md' },
            capturedAt: '2026-10-20T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    await migrateLocalStore(stackHome); // first run completes migration (no project items here)

    // Simulate a later, independent global backup that updates current.json.
    const newHash = await putObject(Buffer.from('global instructions v2'));
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-22T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'user-instructions',
            scope: 'global',
            logicalId: 'claude/user-instructions/global/CLAUDE.md',
            contentHash: newHash,
            restoreTarget: { base: 'claude-home', relativePath: 'CLAUDE.md' },
            capturedAt: '2026-10-22T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });

    await migrateLocalStore(stackHome); // must NOT revert the above

    const current = memoryManifestSchema.parse(
      JSON.parse(await readFile(path.join(stackHome, 'memory', 'manifests', 'current.json'), 'utf8')),
    );
    expect(current.items[0]?.contentHash).toBe(newHash); // not reverted to the old hash
  });
});
