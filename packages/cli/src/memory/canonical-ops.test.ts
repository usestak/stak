import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  encodeClaudeProjectKey,
  readLocalRegistry,
  resolveOrMintProject,
  setBinding,
  writeLocalRegistry,
} from '@stack/memory';

import { canonicalMemoryStatus, stageCanonicalMemory } from './canonical-ops.js';

let root: string;
let stackHome: string;
let claudeHome: string;
let projectDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'stak-canonical-ops-'));
  stackHome = path.join(root, 'stack-home');
  claudeHome = path.join(root, '.claude');
  projectDir = path.join(root, 'proj');
  await mkdir(projectDir, { recursive: true });
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const bindProject = async (dir: string) => {
  let registry = await readLocalRegistry(stackHome);
  const minted = resolveOrMintProject(registry, { kind: 'local', vendorKey: `v-${path.basename(dir)}` });
  registry = setBinding(minted.registry, { projectId: minted.projectId, dir, boundAt: '2026-10-22T00:00:00.000Z', provenance: 'user-map' });
  await writeLocalRegistry(stackHome, registry);
  return minted.projectId;
};

const writeAutoMemory = async (vendorKey: string, name: string, body: string) => {
  const dir = path.join(claudeHome, 'projects', vendorKey, 'memory');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), body, 'utf8');
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

const isDirectoryStat = async (candidate: string): Promise<boolean> => {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
};

const canonicalMainPath = () => path.join(stackHome, 'memory', 'canonical', 'main.json');
const projectionPath = () => path.join(stackHome, 'memory', 'projections', 'claude.json');
const migrationMarkerPath = () => path.join(stackHome, 'memory', 'manifests', '.v1-migration-complete');
const registryPath = () => path.join(stackHome, 'memory', 'projects-local.json');

describe('stageCanonicalMemory', () => {
  it('imports a native edit for a bound project and reports it', async () => {
    const projectId = await bindProject(projectDir);
    await mkdir(path.dirname(path.join(projectDir, 'CLAUDE.local.md')), { recursive: true });
    await writeFile(path.join(projectDir, 'CLAUDE.local.md'), 'private memory');

    const summaries = await stageCanonicalMemory(stackHome, { claudeHome });
    const mine = summaries.find((s) => s.projectId === projectId);
    expect(mine?.imported).toContain('instructions/private.md');
  });

  it('an UNMAPPED project located via a `projects` candidate (the normal, never-mapped case): imports and mints its Project ID', async () => {
    const unmappedDir = path.join(root, 'unmapped');
    await mkdir(unmappedDir, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(path.resolve(unmappedDir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'auto memory notes');

    const registryBefore = await readLocalRegistry(stackHome);
    expect(registryBefore.projects).toHaveLength(0);

    const summaries = await stageCanonicalMemory(stackHome, {
      claudeHome,
      projects: [{ dir: unmappedDir }],
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.imported).toContain('notes/MEMORY.md');

    const registryAfter = await readLocalRegistry(stackHome);
    expect(registryAfter.projects).toHaveLength(1);
    // Minted, but never explicitly bound — located purely via the candidate match.
    expect(registryAfter.bindings).toHaveLength(0);
  });

  it('a brand-new project with native Memory and no registry record: located via reconstruction alone (no `projects` candidate), minted, imported', async () => {
    const freshDir = path.join(root, 'fresh-project');
    await mkdir(freshDir, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(path.resolve(freshDir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'fresh notes');

    const summaries = await stageCanonicalMemory(stackHome, {
      claudeHome,
      isDirectory: isDirectoryStat,
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.imported).toContain('notes/MEMORY.md');
    const registryAfter = await readLocalRegistry(stackHome);
    expect(registryAfter.projects).toHaveLength(1);
  });

  it("a project with an explicit binding uses the binding's dir as the write target for project-local files (CLAUDE.local.md only exists there, not at the vendor-key-derived dir)", async () => {
    const oldDir = path.join(root, 'old-location');
    const newDir = path.join(root, 'new-location');
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });

    const oldVendorKey = encodeClaudeProjectKey(path.resolve(oldDir));
    await writeAutoMemory(oldVendorKey, 'MEMORY.md', 'old notes');

    // Explicitly bind this (local, oldVendorKey) identity's Project ID to the NEW
    // dir — exactly `stak project map` after a relocation the auto-memory folder
    // (still keyed to the old directory) doesn't track on its own.
    let registry = await readLocalRegistry(stackHome);
    const minted = resolveOrMintProject(registry, { kind: 'local', vendorKey: oldVendorKey });
    registry = setBinding(minted.registry, {
      projectId: minted.projectId,
      dir: path.resolve(newDir),
      boundAt: '2026-10-22T00:00:00.000Z',
      provenance: 'user-map',
    });
    await writeLocalRegistry(stackHome, registry);

    await writeFile(path.join(newDir, 'CLAUDE.local.md'), 'private memory at new location');

    const summaries = await stageCanonicalMemory(stackHome, { claudeHome });
    const mine = summaries.find((s) => s.projectId === minted.projectId);
    expect(mine?.imported).toEqual(
      expect.arrayContaining(['notes/MEMORY.md', 'instructions/private.md']),
    );
  });

  it('a project whose folder cannot be located: no actions, no error, canonical Memory untouched', async () => {
    const goneDir = path.join(root, 'gone-project'); // never created on disk
    const vendorKey = encodeClaudeProjectKey(path.resolve(goneDir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'orphaned notes');

    const summaries = await stageCanonicalMemory(stackHome, {
      claudeHome,
      isDirectory: async () => false, // nothing is locatable
    });
    expect(summaries).toHaveLength(0);
    expect(await exists(canonicalMainPath())).toBe(false);

    // The identity is minted (discovery proved it exists), but nothing was synced.
    const registryAfter = await readLocalRegistry(stackHome);
    expect(registryAfter.projects).toHaveLength(1);
    expect(registryAfter.bindings).toHaveLength(0);

    // Idempotent: running again is still a safe no-op, no error.
    const second = await stageCanonicalMemory(stackHome, {
      claudeHome,
      isDirectory: async () => false,
    });
    expect(second).toHaveLength(0);
    expect(await exists(canonicalMainPath())).toBe(false);
  });
});

describe('canonicalMemoryStatus', () => {
  it('is read-only — no canonical file, projection, migration marker, or registry change is ever written', async () => {
    const projectId = await bindProject(projectDir);
    await writeFile(path.join(projectDir, 'CLAUDE.local.md'), 'private memory');
    const registryBefore = await readFile(registryPath(), 'utf8');

    const result = await canonicalMemoryStatus(stackHome, { claudeHome });
    expect(result.projects.find((s) => s.projectId === projectId)?.imported).toEqual([]);

    expect(await exists(canonicalMainPath())).toBe(false);
    expect(await exists(projectionPath())).toBe(false);
    expect(await exists(migrationMarkerPath())).toBe(false);
    expect(await readFile(registryPath(), 'utf8')).toBe(registryBefore);

    // Confirm nothing was actually staged across a second, repeated call either.
    const after = await canonicalMemoryStatus(stackHome, { claudeHome });
    expect(after.projects.find((s) => s.projectId === projectId)?.imported).toEqual([]);
    expect(await exists(canonicalMainPath())).toBe(false);
    expect(await readFile(registryPath(), 'utf8')).toBe(registryBefore);
  });

  it('reports a new, locatable, never-added project as pending — never mints, never writes the registry', async () => {
    const pendingDir = path.join(root, 'pending-project');
    await mkdir(pendingDir, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(path.resolve(pendingDir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'pending notes');

    expect(await exists(registryPath())).toBe(false);

    const result = await canonicalMemoryStatus(stackHome, {
      claudeHome,
      projects: [{ dir: pendingDir }],
    });
    expect(result.newProjects).toBe(1);
    expect(result.projects).toHaveLength(0);

    // Still read-only: no registry file was ever created, nothing minted.
    expect(await exists(registryPath())).toBe(false);
  });
});
