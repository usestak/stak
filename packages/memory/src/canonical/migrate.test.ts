import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { memoryManifestSchema } from '../domain.js';
import { writeMemoryManifest, writeMemoryObject, hashBytes, readMemoryManifest } from '../store.js';
import { v1ManifestFingerprint, writeLocalRecoveryState } from '../local-recovery-state.js';
import { claudeNativeTargetOf } from './claude-project-adapter.js';
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

  // Task 13 fix round 3 (finding C): seeding depends on where the migrated v1
  // manifest came from. Fixture: three auto-memory docs a/b/c for one project.
  const writeAbcManifest = async () => {
    const bodyA = Buffer.from('seed me');
    const hashA = await putObject(bodyA);
    const hashBOriginal = await putObject(Buffer.from('original b'));
    const item = (name: string, contentHash: string) => ({
      provider: 'claude' as const,
      kind: 'auto-memory' as const,
      scope: 'project' as const,
      logicalId: `claude/auto-memory/github.com/acme/widgets/${name}`,
      project: { kind: 'git' as const, canonical: 'github.com/acme/widgets', host: 'github.com', owner: 'acme', repo: 'widgets' },
      contentHash,
      restoreTarget: { base: 'claude-project-memory' as const, relativePath: name },
      capturedAt: '2026-10-20T00:00:00.000Z',
      sensitivity: 'private' as const,
    });
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-20T00:00:00.000Z',
        items: [item('a.md', hashA), item('b.md', hashBOriginal), item('c.md', hashA)],
      },
    });
    // Native files: a.md matches, b.md is absent, c.md holds DIFFERENT content.
    // `claudeNativeTargetOf`'s `notes/` mapping depends only on the project's
    // directory, not its (randomly minted) Project ID.
    const projectDir = path.join(stackHome, 'project-dir');
    await mkdir(projectDir, { recursive: true });
    const claudeHome = path.join(stackHome, 'claude-home');
    const dummyProjectId = 'prj_' + 'a'.repeat(26);
    const targetA = claudeNativeTargetOf({ projectId: dummyProjectId, dir: projectDir }, 'notes/a.md', claudeHome);
    await mkdir(path.dirname(targetA), { recursive: true });
    await writeFile(targetA, bodyA);
    const targetC = claudeNativeTargetOf({ projectId: dummyProjectId, dir: projectDir }, 'notes/c.md', claudeHome);
    await writeFile(targetC, Buffer.from('edited since backup'));
    return { hashA, hashBOriginal, projectDir, claudeHome };
  };

  const recordRecover = async (options: { withFingerprint: boolean }) => {
    const manifest = await readMemoryManifest(stackHome);
    await writeLocalRecoveryState(stackHome, {
      schemaVersion: 1,
      recoveredGeneration: 0,
      cloudLatestAtRecovery: 0,
      recoveredAt: '2026-10-21T00:00:00.000Z',
      privacyMode: 'standard',
      ...(options.withFingerprint && manifest
        ? { recoveredManifestFingerprint: v1ManifestFingerprint(manifest) }
        : {}),
    });
  };

  const projectionFor = async () => {
    const { readProjection } = await import('./store.js');
    const projection = await readProjection(stackHome, 'claude');
    const main = await readCanonicalMain(stackHome);
    return projection.projects[main.projects[0]!.projectId];
  };

  it('a LOCALLY produced manifest seeds P = C for every native file that EXISTS (edited or not); an ABSENT one is not seeded and is counted as restored (Task 13 fix round 4)', async () => {
    const { hashA, projectDir, claudeHome } = await writeAbcManifest();
    const summary = await migrateLocalStore(stackHome, { locateProjectDir: async () => projectDir, claudeHome });
    const seeded = await projectionFor();
    expect(seeded?.['notes/a.md']).toBe(hashA); // exists, unchanged
    expect(seeded?.['notes/c.md']).toBe(hashA); // exists, edited since -> later an import-edit
    expect(seeded?.['notes/b.md']).toBeUndefined(); // absent -> materialized back, never import-deleted
    expect(summary.restoredFromStak).toBe(1);
    // A second run is a no-op and restores nothing more.
    expect((await migrateLocalStore(stackHome)).restoredFromStak).toBe(0);
  });

  it('a manifest last touched by a PUSH (provenance without a recover fingerprint) is local: an edited native file is seeded', async () => {
    const { hashA, projectDir, claudeHome } = await writeAbcManifest();
    await recordRecover({ withFingerprint: false });
    await migrateLocalStore(stackHome, { locateProjectDir: async () => projectDir, claudeHome });
    expect((await projectionFor())?.['notes/c.md']).toBe(hashA);
    expect((await projectionFor())?.['notes/b.md']).toBeUndefined();
  });

  it('a manifest restored by a Cloud recover seeds ONLY native files that exist with matching content (fresh machine; Task 13 fix round 2, finding 5)', async () => {
    const { hashA, projectDir, claudeHome } = await writeAbcManifest();
    await recordRecover({ withFingerprint: true });
    const summary = await migrateLocalStore(stackHome, { locateProjectDir: async () => projectDir, claudeHome });
    const seeded = await projectionFor();
    expect(seeded?.['notes/a.md']).toBe(hashA); // exists, matches -> seeded
    expect(seeded?.['notes/b.md']).toBeUndefined(); // absent -> NOT seeded (materialized later)
    expect(seeded?.['notes/c.md']).toBeUndefined(); // differs -> NOT seeded (first-sighting conflict)
    expect(summary.restoredFromStak).toBe(1);
  });

  it('with no locatable directory nothing is seeded, whatever the origin', async () => {
    await writeAbcManifest();
    await migrateLocalStore(stackHome);
    expect(await projectionFor()).toBeUndefined();
  });

  it('a recover fingerprint that no longer matches the manifest (staged locally since) is local: an edited native file is seeded', async () => {
    const { hashA, projectDir, claudeHome } = await writeAbcManifest();
    await recordRecover({ withFingerprint: true });
    // A local v1 `stak add` since the recover rewrote the manifest.
    const manifest = await readMemoryManifest(stackHome);
    await writeMemoryManifest({ stackHome, manifest: { ...manifest!, createdAt: '2026-10-22T00:00:00.000Z' } });
    await migrateLocalStore(stackHome, { locateProjectDir: async () => projectDir, claudeHome });
    expect((await projectionFor())?.['notes/c.md']).toBe(hashA);
  });

  it('calls the directory locator only AFTER the build step, so a Project ID minted during migration is located', async () => {
    const { projectDir, claudeHome } = await writeAbcManifest();
    await recordRecover({ withFingerprint: true });
    const asked: string[] = [];
    await migrateLocalStore(stackHome, {
      locateProjectDir: async (projectId) => {
        asked.push(projectId);
        // The registry already holds the freshly minted ID by now.
        const { readLocalRegistry } = await import('../project/registry-store.js');
        const registry = await readLocalRegistry(stackHome);
        return registry.projects.some((p) => p.projectId === projectId) ? projectDir : undefined;
      },
      claudeHome,
    });
    const main = await readCanonicalMain(stackHome);
    expect(asked).toEqual([main.projects[0]!.projectId]);
    expect((await projectionFor())?.['notes/a.md']).toBeDefined();
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

  it('keeps the MOST RECENTLY captured copy when collapsing identical-hash duplicates, regardless of manifest array order', async () => {
    // Three manifest entries at one canonical path, all under the SAME proven
    // (git) identity: an OLDER copy and a NEWER copy that are byte-identical
    // (same hash, captured at two different times), plus a third entry with
    // genuinely DIFFERENT content captured in between. The older same-hash copy
    // is placed FIRST in the array and the newer one LAST, specifically so a
    // "first manifest entry with this hash wins" bug (instead of "the one with
    // the greatest capturedAt wins") would pick the wrong entry: under that bug,
    // the stale `capturedAt: 2026-10-18` copy would survive the hash-collapse,
    // and since it is now compared to the differing entry's `2026-10-20`, the
    // (wrong) DIFFERING entry would end up winning the "primary, unsuffixed
    // path" slot instead of the shared-hash content — the opposite of what the
    // spec requires ("the most recently captured one keeps the original name").
    const hashShared = await putObject(Buffer.from('shared content'));
    const hashDiff = await putObject(Buffer.from('different content'));
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
        createdAt: '2026-10-22T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/widgets/a.md#shared-old',
            project: identity,
            contentHash: hashShared,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
            capturedAt: '2026-10-18T00:00:00.000Z', // oldest of the shared-hash pair
            sensitivity: 'private',
          },
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/widgets/a.md#diff',
            project: identity,
            contentHash: hashDiff,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
            capturedAt: '2026-10-20T00:00:00.000Z', // strictly between the shared-hash pair
            sensitivity: 'private',
          },
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/widgets/a.md#shared-new',
            project: identity,
            contentHash: hashShared,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
            capturedAt: '2026-10-22T00:00:00.000Z', // newest of the shared-hash pair, LAST in array
            sensitivity: 'private',
          },
        ],
      },
    });
    const summary = await migrateLocalStore(stackHome);
    // Three entries, two distinct hashes after collapsing the identical pair.
    expect(summary.keptBothDuplicates).toBe(1);
    const main = await readCanonicalMain(stackHome);
    expect(main.projects).toHaveLength(1);
    const docs = main.projects[0]!.documents;
    const primary = docs.find((d) => d.path === 'notes/a.md');
    expect(primary).toMatchObject({
      contentHash: hashShared,
      importedAt: '2026-10-22T00:00:00.000Z', // the NEWEST shared-hash copy, not the first-seen one
    });
    const conflict = docs.find((d) => d.path !== 'notes/a.md');
    expect(conflict).toMatchObject({ contentHash: hashDiff, importedAt: '2026-10-20T00:00:00.000Z' });
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

  it('never mints a registry entry or a phantom project for a project-scope item with no mappable canonical path', async () => {
    // `scope: 'project'` paired with a `kind` that `claudeCanonicalPathOf` maps to
    // `null` (e.g. `user-instructions`, which real Claude discovery only ever
    // produces as `scope: 'global'`) is an edge case the schema technically
    // allows. Minting a Project ID for such an item — even though it can never
    // produce a document — would leave a phantom, document-less project behind
    // in both the registry and `main.json`. The pre-mint filter must skip it
    // BEFORE any registry mutation happens.
    const hash = await putObject(Buffer.from('edge case content'));
    const identity = {
      kind: 'git' as const,
      canonical: 'github.com/acme/orphan',
      host: 'github.com',
      owner: 'acme',
      repo: 'orphan',
    };
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
            scope: 'project',
            logicalId: 'claude/user-instructions/github.com/acme/orphan/CLAUDE.md',
            project: identity,
            contentHash: hash,
            restoreTarget: { base: 'claude-home', relativePath: 'CLAUDE.md' },
            capturedAt: '2026-10-22T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    const summary = await migrateLocalStore(stackHome);
    expect(summary.migratedDocuments).toBe(0);
    const main = await readCanonicalMain(stackHome);
    expect(main.projects).toEqual([]); // no phantom project
    const { readLocalRegistry } = await import('../project/registry-store.js');
    const registry = await readLocalRegistry(stackHome);
    expect(registry.projects).toEqual([]); // no registry entry minted for it
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
