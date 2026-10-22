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
