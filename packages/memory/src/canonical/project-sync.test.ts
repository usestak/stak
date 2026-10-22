import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashBytes, readMemoryObject, writeMemoryObject } from '../store.js';
import { CANONICAL_MAIN_SCHEMA_VERSION, type CanonicalDoc } from './domain.js';
import { writeCanonicalMain, readCanonicalMain, writeProjection, readProjection } from './store.js';
import { applyImportActions, applyMaterializeActions, planProjectSync } from './project-sync.js';

const write = async (file: string, body: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
};

let root: string;
let stackHome: string;
let claudeHome: string;
let projectDir: string;
const project = { projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa', dir: '' };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'stak-project-sync-'));
  stackHome = path.join(root, 'stack-home');
  claudeHome = path.join(root, '.claude');
  projectDir = path.join(root, 'proj');
  await mkdir(projectDir, { recursive: true });
  project.dir = projectDir;
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe('planProjectSync', () => {
  it('reports no actions when the project directory does not exist on this machine', async () => {
    const plan = await planProjectSync(
      { projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa', dir: path.join(root, 'missing') },
      stackHome,
      { claudeHome, projects: [{ dir: path.join(root, 'missing') }], resolveProjectId: () => 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
    );
    expect(plan.actions).toEqual([]);
  });

  it('plans a native edit as import-edit', async () => {
    await write(path.join(projectDir, 'CLAUDE.local.md'), 'private v1');
    const plan = await planProjectSync(project, stackHome, {
      claudeHome,
      projects: [{ dir: projectDir }],
      resolveProjectId: () => 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(plan.actions).toEqual([
      { kind: 'import-edit', path: 'instructions/private.md', contentHash: hashBytes(Buffer.from('private v1')) },
    ]);
  });

  it('mass-delete guard: a missing notes root plans a materialize-write (regenerate), never an import-delete', async () => {
    const bytes = Buffer.from('MEMORY content');
    const contentHash = hashBytes(bytes);
    await writeMemoryObject({ stackHome, contentHash, bytes });
    await writeCanonicalMain(stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [{ projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa', documents: [{ path: 'notes/MEMORY.md', state: 'present', contentHash, importedFrom: 'claude', importedAt: '2026-10-22T00:00:00.000Z' }] }],
    });
    await writeProjection(stackHome, 'claude', { schemaVersion: 1, projects: { prj_aaaaaaaaaaaaaaaaaaaaaaaaaa: { 'notes/MEMORY.md': contentHash } } });
    // Note: claudeHome/projects/<key>/memory is never created, so the notes root is missing.

    const plan = await planProjectSync(project, stackHome, {
      claudeHome,
      projects: [{ dir: projectDir }],
      resolveProjectId: () => 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(plan.guardedPaths).toEqual(['notes/MEMORY.md']);
    expect(plan.actions).toContainEqual({ kind: 'materialize-write', path: 'notes/MEMORY.md', contentHash });
    expect(plan.actions.some((a) => a.kind === 'import-delete')).toBe(false);
  });

  it('the guard does NOT protect a notes root that genuinely exists but is now empty — that is a real deletion', async () => {
    const bytes = Buffer.from('MEMORY content');
    const contentHash = hashBytes(bytes);
    await writeMemoryObject({ stackHome, contentHash, bytes });
    await writeCanonicalMain(stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [{ projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa', documents: [{ path: 'notes/MEMORY.md', state: 'present', contentHash, importedFrom: 'claude', importedAt: '2026-10-22T00:00:00.000Z' }] }],
    });
    await writeProjection(stackHome, 'claude', { schemaVersion: 1, projects: { prj_aaaaaaaaaaaaaaaaaaaaaaaaaa: { 'notes/MEMORY.md': contentHash } } });
    // The notes root DOES exist this time — just empty (the user deleted the file,
    // the directory itself is untouched). A regression that guards on "no files
    // found" instead of "root missing" would wrongly protect this too.
    const { encodeClaudeProjectKey } = await import('../project-identity.js');
    const encodedKey = encodeClaudeProjectKey(path.resolve(projectDir));
    await mkdir(path.join(claudeHome, 'projects', encodedKey, 'memory'), { recursive: true });

    const plan = await planProjectSync(project, stackHome, {
      claudeHome,
      projects: [{ dir: projectDir }],
      resolveProjectId: () => 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(plan.guardedPaths).toEqual([]);
    expect(plan.actions).toContainEqual({ kind: 'import-delete', path: 'notes/MEMORY.md' });
  });

  it("a symlinked Claude project-key folder is treated the same as a missing one, matching discovery's own symlink-skipping rule", async () => {
    const bytes = Buffer.from('MEMORY content');
    const contentHash = hashBytes(bytes);
    await writeMemoryObject({ stackHome, contentHash, bytes });
    await writeCanonicalMain(stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [{ projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa', documents: [{ path: 'notes/MEMORY.md', state: 'present', contentHash, importedFrom: 'claude', importedAt: '2026-10-22T00:00:00.000Z' }] }],
    });
    await writeProjection(stackHome, 'claude', { schemaVersion: 1, projects: { prj_aaaaaaaaaaaaaaaaaaaaaaaaaa: { 'notes/MEMORY.md': contentHash } } });
    const encodedKey = (await import('../project-identity.js')).encodeClaudeProjectKey(path.resolve(projectDir));
    const realTarget = path.join(root, 'symlink-target-with-memory');
    await mkdir(path.join(realTarget, 'memory'), { recursive: true });
    await mkdir(path.join(claudeHome, 'projects'), { recursive: true });
    try {
      await (await import('node:fs/promises')).symlink(realTarget, path.join(claudeHome, 'projects', encodedKey), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return; // no symlink privilege on this machine; skip
      throw error;
    }

    const plan = await planProjectSync(project, stackHome, {
      claudeHome,
      projects: [{ dir: projectDir }],
      resolveProjectId: () => 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    // discoverClaudeMemory's own listDirNames would skip this symlinked key folder
    // entirely, so the guard MUST agree it does not "exist" either — otherwise the
    // scan finds nothing while the guard thinks the root is fine, and the real
    // (but invisible-to-the-scan) notes/MEMORY.md gets planned as deleted.
    expect(plan.guardedPaths).toEqual(['notes/MEMORY.md']);
    expect(plan.actions.some((a) => a.kind === 'import-delete')).toBe(false);
  });

  it('a source conflict at notes/MEMORY.md produces NO action (not import-delete), while an unrelated edit still plans normally', async () => {
    // Two Claude memory folders for the SAME resolved project (matched purely via
    // the `resolveProjectId` stub below, which ignores its `item` argument — see
    // claude-project-adapter.test.ts's own source-conflict test for the identical
    // pattern) disagree on content at `notes/MEMORY.md`. This is a genuine source
    // conflict: `scanClaudeProject` refuses to pick a winner and omits the path
    // from `scanResult.docs` entirely.
    await write(path.join(claudeHome, 'projects', 'key-old', 'memory', 'MEMORY.md'), 'old');
    await write(path.join(claudeHome, 'projects', 'key-new', 'memory', 'MEMORY.md'), 'new');

    // The mass-delete guard keys off THIS project's own encoded key folder, which
    // is neither `key-old` nor `key-new` above — create it (empty) so the guard
    // sees a genuine, existing notes root and stays out of the way. Without this,
    // `notesRootExists` would be false and the guard itself would strip the
    // projection entry below, masking what this test is actually pinning (the
    // conflict filter, not the mass-delete guard).
    const { encodeClaudeProjectKey } = await import('../project-identity.js');
    const ownEncodedKey = encodeClaudeProjectKey(path.resolve(projectDir));
    await mkdir(path.join(claudeHome, 'projects', ownEncodedKey, 'memory'), { recursive: true });

    // An existing projection entry for the conflicted path: this is what the
    // Critical bug needed to reproduce — without it, `planSync` would see
    // "first sighting, native absent" (`materialize-write`, not `import-delete`),
    // not the "native changed since last sync" branch the bug actually hit.
    const syncedHash = hashBytes(Buffer.from('old'));
    await writeCanonicalMain(stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [{ projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa', documents: [{ path: 'notes/MEMORY.md', state: 'present', contentHash: syncedHash, importedFrom: 'claude', importedAt: '2026-10-22T00:00:00.000Z' }] }],
    });
    await writeProjection(stackHome, 'claude', { schemaVersion: 1, projects: { prj_aaaaaaaaaaaaaaaaaaaaaaaaaa: { 'notes/MEMORY.md': syncedHash } } });

    // A second, unrelated, non-conflicted native edit in the same project, to
    // confirm the conflict filter doesn't over-exclude.
    await write(path.join(projectDir, 'CLAUDE.local.md'), 'private v1');

    const plan = await planProjectSync(project, stackHome, {
      claudeHome,
      projects: [{ dir: projectDir }],
      resolveProjectId: () => 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    expect(plan.actions.find((a) => 'path' in a && a.path === 'notes/MEMORY.md')).toBeUndefined();
    expect(plan.sourceConflicts).toContainEqual({ canonicalPath: 'notes/MEMORY.md' });
    expect(plan.actions).toContainEqual({
      kind: 'import-edit',
      path: 'instructions/private.md',
      contentHash: hashBytes(Buffer.from('private v1')),
    });
  });
});

describe('applyImportActions and applyMaterializeActions', () => {
  it('imports a native edit into canonical, then materializes a canonical-only change back out', async () => {
    await write(path.join(projectDir, 'CLAUDE.local.md'), 'private v1');
    let plan = await planProjectSync(project, stackHome, {
      claudeHome,
      projects: [{ dir: projectDir }],
      resolveProjectId: () => 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const { scanClaudeProject } = await import('./claude-project-adapter.js');
    const scanResult = await scanClaudeProject(project, {
      claudeHome,
      projects: [{ dir: projectDir }],
      resolveProjectId: () => 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    await applyImportActions(project, stackHome, scanResult, plan.actions);

    const main = await readCanonicalMain(stackHome);
    expect(main.projects[0]?.documents[0]).toMatchObject({ path: 'instructions/private.md', state: 'present' });
    const projection = await readProjection(stackHome, 'claude');
    expect(projection.projects['prj_aaaaaaaaaaaaaaaaaaaaaaaaaa']?.['instructions/private.md']).toBeDefined();

    // Now simulate a canonical-only change (as if it arrived from another machine).
    const mainAfterRemote = await readCanonicalMain(stackHome);
    const newHash = hashBytes(Buffer.from('private v2'));
    await writeMemoryObject({ stackHome, contentHash: newHash, bytes: Buffer.from('private v2') });
    await writeCanonicalMain(stackHome, {
      ...mainAfterRemote,
      projects: mainAfterRemote.projects.map((p) => ({
        ...p,
        documents: p.documents.map((d) =>
          d.path === 'instructions/private.md'
            ? {
                path: d.path,
                state: 'present' as const,
                contentHash: newHash,
                importedFrom: 'claude' as const,
                importedAt: '2026-10-22T00:00:00.000Z',
              }
            : d,
        ),
      })),
    });
    plan = await planProjectSync(project, stackHome, {
      claudeHome,
      projects: [{ dir: projectDir }],
      resolveProjectId: () => 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(plan.actions).toEqual([{ kind: 'materialize-write', path: 'instructions/private.md', contentHash: newHash }]);
    const result = await applyMaterializeActions(project, stackHome, plan.actions, claudeHome);
    expect(result.written).toEqual(['instructions/private.md']);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path.join(projectDir, 'CLAUDE.local.md'), 'utf8')).toBe('private v2');
  });
});
