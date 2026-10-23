import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CANONICAL_MAIN_SCHEMA_VERSION,
  canonicalGitIdentity,
  emptyRegistry,
  encodeClaudeProjectKey,
  fileLocalMemoryKeyStore,
  hashBytes,
  InMemoryRemoteMemoryStore,
  inMemoryRemoteMemoryBackend,
  legacyCompatKey,
  mintProjectId,
  readCanonicalBase,
  readCanonicalMain,
  readLocalRegistry,
  resolveOrMintProject,
  setBinding,
  shortProjectId,
  writeCanonicalMain,
  writeLocalRegistry,
  writeMemoryManifest,
  type BackupResult,
  type RemoteMemoryBackend,
} from '@stack/memory';

import {
  canonicalMemoryStatus,
  materializeCanonicalProjects,
  pullMemoryViaCanonical,
  pushMemoryViaCanonical,
  stageCanonicalMemory,
} from './canonical-ops.js';
import { runMemoryCloudRecover } from './cloud-ops.js';

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

/** Flip the case of a vendor key's first character (the drive letter on win32) —
 * used to simulate Claude producing a differently-cased vendor key for the SAME
 * real, case-insensitive folder than `encodeClaudeProjectKey` independently
 * computes (the Critical identity bug this file's win32 test exercises). */
const flipFirstCharCase = (key: string): string => {
  const first = key[0] as string;
  const flipped = first === first.toLowerCase() ? first.toUpperCase() : first.toLowerCase();
  return flipped + key.slice(1);
};

describe('stageCanonicalMemory', () => {
  it('imports a native edit for a bound project and reports it', async () => {
    const projectId = await bindProject(projectDir);
    await mkdir(path.dirname(path.join(projectDir, 'CLAUDE.local.md')), { recursive: true });
    await writeFile(path.join(projectDir, 'CLAUDE.local.md'), 'private memory');

    const result = await stageCanonicalMemory(stackHome, { claudeHome });
    const mine = result.projects.find((s) => s.projectId === projectId);
    expect(mine?.imported).toContain('instructions/private.md');
  });

  it('an UNMAPPED project located via a `projects` candidate (the normal, never-mapped case): imports and mints its Project ID', async () => {
    const unmappedDir = path.join(root, 'unmapped');
    await mkdir(unmappedDir, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(path.resolve(unmappedDir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'auto memory notes');

    const registryBefore = await readLocalRegistry(stackHome);
    expect(registryBefore.projects).toHaveLength(0);

    const result = await stageCanonicalMemory(stackHome, {
      claudeHome,
      projects: [{ dir: unmappedDir }],
    });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.imported).toContain('notes/MEMORY.md');

    const registryAfter = await readLocalRegistry(stackHome);
    expect(registryAfter.projects).toHaveLength(1);
    // Minted, but never explicitly bound — located purely via the candidate match.
    expect(registryAfter.bindings).toHaveLength(0);
  });

  it('a dotted-path project (`.claude-mem`-style directory name) located via a `projects` candidate match: staged', async () => {
    const dottedDir = path.join(root, '.claude-mem');
    await mkdir(dottedDir, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(path.resolve(dottedDir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'dotted project notes');

    const result = await stageCanonicalMemory(stackHome, {
      claudeHome,
      projects: [{ dir: dottedDir }],
    });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.imported).toContain('notes/MEMORY.md');
    const registryAfter = await readLocalRegistry(stackHome);
    expect(registryAfter.projects).toHaveLength(1);
  });

  it('a brand-new project with native Memory and no registry record: located via reconstruction alone (no `projects` candidate), minted, imported', async () => {
    const freshDir = path.join(root, 'fresh-project');
    await mkdir(freshDir, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(path.resolve(freshDir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'fresh notes');

    const result = await stageCanonicalMemory(stackHome, {
      claudeHome,
      isDirectory: isDirectoryStat,
    });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.imported).toContain('notes/MEMORY.md');
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

    const result = await stageCanonicalMemory(stackHome, { claudeHome });
    const mine = result.projects.find((s) => s.projectId === minted.projectId);
    expect(mine?.imported).toEqual(
      expect.arrayContaining(['notes/MEMORY.md', 'instructions/private.md']),
    );
  });

  it('a bound dir whose auto-memory resolves to a Git identity with NO existing Git claim: everything lands on the bound Project, no second (phantom) Project is minted', async () => {
    const dir = path.join(root, 'checkout');
    await mkdir(dir, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(path.resolve(dir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'checkout notes');

    // Explicitly bind this directory to an existing Project — no Git claim exists
    // for it anywhere in the registry.
    let registry = await readLocalRegistry(stackHome);
    const minted = resolveOrMintProject(registry, { kind: 'local', vendorKey: `v-${path.basename(dir)}` });
    registry = setBinding(minted.registry, {
      projectId: minted.projectId,
      dir: path.resolve(dir),
      boundAt: '2026-10-22T00:00:00.000Z',
      provenance: 'user-map',
    });
    await writeLocalRegistry(stackHome, registry);

    // Discovery resolves this vendor key to a STRONG Git identity (via
    // reconstruction + gitRemoteOf) — a different identity KIND than the binding's
    // own local claim, but the binding is proof of ownership regardless of kind.
    const result = await stageCanonicalMemory(stackHome, {
      claudeHome,
      isDirectory: isDirectoryStat,
      gitRemoteOf: async (candidate) =>
        path.resolve(candidate) === path.resolve(dir)
          ? 'https://github.com/example/checkout.git'
          : undefined,
    });

    expect(result.projects).toHaveLength(1);
    const mine = result.projects.find((s) => s.projectId === minted.projectId);
    expect(mine?.imported).toContain('notes/MEMORY.md');

    const registryAfter = await readLocalRegistry(stackHome);
    expect(registryAfter.projects).toHaveLength(1); // no second, phantom Project
  });

  it('win32: a local project whose notes-folder vendor key uses a differently-cased drive letter than its CLAUDE.local.md key resolves to ONE Project ID, both documents under it', async () => {
    const dir = path.join(root, 'case-project');
    await mkdir(dir, { recursive: true });
    const naturalKey = encodeClaudeProjectKey(path.resolve(dir));
    const differentlyCasedKey = flipFirstCharCase(naturalKey);
    expect(differentlyCasedKey).not.toBe(naturalKey); // sanity: the two variants actually differ

    // Claude's own auto-memory folder uses the differently-cased vendor key; the
    // project's own `CLAUDE.local.md` resolves via `encodeClaudeProjectKey` to the
    // NATURAL-cased key (via the `projects` candidate below) — same real folder on
    // a case-insensitive (win32) filesystem, two different raw vendor-key strings.
    await writeAutoMemory(differentlyCasedKey, 'MEMORY.md', 'case notes');
    await writeFile(path.join(dir, 'CLAUDE.local.md'), 'private memory');

    const result = await stageCanonicalMemory(stackHome, {
      claudeHome,
      projects: [{ dir }],
      platform: 'win32',
    });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.imported).toEqual(
      expect.arrayContaining(['notes/MEMORY.md', 'instructions/private.md']),
    );
    const registryAfter = await readLocalRegistry(stackHome);
    expect(registryAfter.projects).toHaveLength(1); // ONE Project, not two
  });

  it('a project whose folder cannot be located and has NO Project ID at all: reported as an untracked folder (quiet, un-actionable), no error, canonical Memory untouched, nothing minted', async () => {
    const goneDir = path.join(root, 'gone-project'); // never created on disk
    const vendorKey = encodeClaudeProjectKey(path.resolve(goneDir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'orphaned notes');

    const result = await stageCanonicalMemory(stackHome, {
      claudeHome,
      isDirectory: async () => false, // nothing is locatable
    });
    expect(result.projects).toHaveLength(0);
    expect(result.unlocatableProjects).toEqual([]); // never claimed — nothing to name
    expect(result.untrackedFolders).toBe(1); // reported, not a silent gap
    expect(await exists(canonicalMainPath())).toBe(false);

    // Important: minting only happens AFTER a write-target directory is located —
    // an unlocatable identity must never create a registry record at all.
    const registryAfter = await readLocalRegistry(stackHome);
    expect(registryAfter.projects).toHaveLength(0);
    expect(registryAfter.bindings).toHaveLength(0);

    // Idempotent: running again is still a safe no-op, no error.
    const second = await stageCanonicalMemory(stackHome, {
      claudeHome,
      isDirectory: async () => false,
    });
    expect(second.projects).toHaveLength(0);
    expect(second.untrackedFolders).toBe(1);
    expect(await exists(canonicalMainPath())).toBe(false);
  });

  it('a REGISTERED project (already claimed) whose folder cannot currently be located: reported by name as unlocatable, never re-minted, never staged', async () => {
    const goneDir = path.join(root, 'gone-known-project');
    const vendorKey = encodeClaudeProjectKey(path.resolve(goneDir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'orphaned notes');

    let registry = await readLocalRegistry(stackHome);
    const minted = resolveOrMintProject(registry, { kind: 'local', vendorKey });
    registry = minted.registry;
    await writeLocalRegistry(stackHome, registry);

    const result = await stageCanonicalMemory(stackHome, {
      claudeHome,
      isDirectory: async () => false, // the directory genuinely isn't there anymore
    });
    expect(result.projects).toHaveLength(0);
    expect(result.untrackedFolders).toBe(0); // it HAS a Project ID — not "untracked"
    expect(result.unlocatableProjects).toHaveLength(1);
    expect(result.unlocatableProjects[0]?.projectId).toBe(minted.projectId);
    expect(result.unlocatableProjects[0]?.name).toBe(shortProjectId(minted.projectId)); // no name hint set

    const registryAfter = await readLocalRegistry(stackHome);
    expect(registryAfter.projects).toHaveLength(1); // unchanged — no second Project minted
  });

  it('a project-local v1 claim under the OLD (pre-fix) encoding resolves to that same Project after the encoder fix, with no new Project minted', async () => {
    const dottedDir = path.join(root, '.legacy-claude-mem');
    await mkdir(dottedDir, { recursive: true });

    // Pre-existing claim under the OLD encoding rule (only `:\/` replaced) — this
    // is what a project-local v1 item captured BEFORE the encoder fix would have
    // been claimed under.
    const oldKey = path.resolve(dottedDir).replace(/[:\\/]/g, '-');
    const newKey = encodeClaudeProjectKey(path.resolve(dottedDir));
    expect(oldKey).not.toBe(newKey); // sanity: the fix actually changes this key

    let registry = await readLocalRegistry(stackHome);
    const minted = resolveOrMintProject(registry, { kind: 'local', vendorKey: oldKey });
    registry = minted.registry;
    await writeLocalRegistry(stackHome, registry);

    await writeFile(path.join(dottedDir, 'CLAUDE.local.md'), 'private memory');

    const result = await stageCanonicalMemory(stackHome, {
      claudeHome,
      projects: [{ dir: dottedDir }],
    });

    expect(result.projects).toHaveLength(1);
    const mine = result.projects.find((s) => s.projectId === minted.projectId);
    expect(mine?.imported).toContain('instructions/private.md');

    const registryAfter = await readLocalRegistry(stackHome);
    expect(registryAfter.projects).toHaveLength(1); // the SAME Project — no duplicate minted
  });

  it('the OLD-encoding alias is a FALLBACK only: a dir with BOTH a new-key claim (P_auto, via its auto-memory folder) and an old-key claim (P_old, a pre-fix v1 CLAUDE.local.md) resolves to P_auto, not a conflict — everything syncs under it', async () => {
    const dottedDir = path.join(root, '.legacy-claude-mem-both');
    await mkdir(dottedDir, { recursive: true });
    const newKey = encodeClaudeProjectKey(path.resolve(dottedDir));
    const oldKey = path.resolve(dottedDir).replace(/[:\\/]/g, '-');
    expect(oldKey).not.toBe(newKey); // sanity: the fix actually changes this key

    await writeAutoMemory(newKey, 'MEMORY.md', 'auto memory notes');

    let registry = await readLocalRegistry(stackHome);
    const mintedAuto = resolveOrMintProject(registry, { kind: 'local', vendorKey: newKey });
    registry = mintedAuto.registry;
    const mintedOld = resolveOrMintProject(registry, { kind: 'local', vendorKey: oldKey });
    registry = mintedOld.registry;
    await writeLocalRegistry(stackHome, registry);
    expect(mintedAuto.projectId).not.toBe(mintedOld.projectId); // sanity: genuinely two Projects

    await writeFile(path.join(dottedDir, 'CLAUDE.local.md'), 'private memory');

    const result = await stageCanonicalMemory(stackHome, {
      claudeHome,
      projects: [{ dir: dottedDir }],
    });

    expect(result.conflictedProjects).toBe(0);
    expect(result.projects).toHaveLength(1);
    const mine = result.projects.find((s) => s.projectId === mintedAuto.projectId);
    expect(mine?.imported).toEqual(
      expect.arrayContaining(['notes/MEMORY.md', 'instructions/private.md']),
    );

    const registryAfter = await readLocalRegistry(stackHome);
    expect(registryAfter.projects).toHaveLength(2); // still exactly P_auto, P_old — no third minted
  });

  it('two Project IDs with a conflicting claim on the same identity: never staged, never a third phantom Project, reported as conflicted', async () => {
    const conflictDir = path.join(root, 'conflict-project');
    await mkdir(conflictDir, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(path.resolve(conflictDir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'conflicted notes');

    // Manufacture a genuine registry conflict: two DISTINCT Project IDs both
    // carrying a claim for the SAME identity (the normal mint/resolve path never
    // produces this on its own — this simulates e.g. a cross-machine merge gone
    // wrong, which `resolveProjectForIdentity` must still fail closed on).
    const idA = mintProjectId();
    const idB = mintProjectId();
    const claim = { type: 'legacy-compat' as const, key: legacyCompatKey(`local:${vendorKey}`) };
    const registry = {
      ...emptyRegistry(),
      projects: [
        { projectId: idA, claims: [claim], lifecycle: 'active' as const },
        { projectId: idB, claims: [claim], lifecycle: 'active' as const },
      ],
    };
    await writeLocalRegistry(stackHome, registry);

    const result = await stageCanonicalMemory(stackHome, {
      claudeHome,
      projects: [{ dir: conflictDir }],
    });
    expect(result.projects).toHaveLength(0);
    expect(result.conflictedProjects).toBe(1);

    const registryAfter = await readLocalRegistry(stackHome);
    expect(registryAfter.projects).toHaveLength(2); // still exactly idA, idB — no third minted
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

  it('reports a planned (not-yet-applied) edit to a REGISTERED project as pending, then 0 after staging', async () => {
    const projectId = await bindProject(projectDir);
    await writeFile(path.join(projectDir, 'CLAUDE.local.md'), 'private memory v1');

    const before = await canonicalMemoryStatus(stackHome, { claudeHome });
    const mineBefore = before.projects.find((s) => s.projectId === projectId);
    expect(mineBefore?.pending).toBe(1);
    expect(mineBefore?.imported).toEqual([]); // status never applies anything

    await stageCanonicalMemory(stackHome, { claudeHome });

    const after = await canonicalMemoryStatus(stackHome, { claudeHome });
    const mineAfter = after.projects.find((s) => s.projectId === projectId);
    expect(mineAfter?.pending).toBe(0);
  });

  it('two Project IDs with a conflicting claim on the same identity: excluded from newProjects, reported as conflicted', async () => {
    const conflictDir = path.join(root, 'conflict-project');
    await mkdir(conflictDir, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(path.resolve(conflictDir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'conflicted notes');

    const idA = mintProjectId();
    const idB = mintProjectId();
    const claim = { type: 'legacy-compat' as const, key: legacyCompatKey(`local:${vendorKey}`) };
    const registry = {
      ...emptyRegistry(),
      projects: [
        { projectId: idA, claims: [claim], lifecycle: 'active' as const },
        { projectId: idB, claims: [claim], lifecycle: 'active' as const },
      ],
    };
    await writeLocalRegistry(stackHome, registry);

    const result = await canonicalMemoryStatus(stackHome, {
      claudeHome,
      projects: [{ dir: conflictDir }],
    });
    expect(result.newProjects).toBe(0);
    expect(result.conflictedProjects).toBe(1);
    expect(result.projects).toHaveLength(0);
  });

  it('reports an untracked, un-claimed folder as a separate quiet count, excluded from newProjects and unlocatableProjects', async () => {
    const goneDir = path.join(root, 'gone-project'); // never created on disk
    const vendorKey = encodeClaudeProjectKey(path.resolve(goneDir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'orphaned notes');

    const result = await canonicalMemoryStatus(stackHome, {
      claudeHome,
      isDirectory: async () => false,
    });
    expect(result.untrackedFolders).toBe(1);
    expect(result.unlocatableProjects).toEqual([]);
    expect(result.newProjects).toBe(0);
    expect(result.projects).toHaveLength(0);
    expect(await exists(registryPath())).toBe(false); // still read-only, nothing written
  });

  it('reports a REGISTERED project whose folder cannot be located by name, read-only', async () => {
    const goneDir = path.join(root, 'gone-known-project');
    const vendorKey = encodeClaudeProjectKey(path.resolve(goneDir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'orphaned notes');

    let registry = await readLocalRegistry(stackHome);
    const minted = resolveOrMintProject(registry, { kind: 'local', vendorKey });
    registry = minted.registry;
    await writeLocalRegistry(stackHome, registry);
    const registryBefore = await readFile(registryPath(), 'utf8');

    const result = await canonicalMemoryStatus(stackHome, {
      claudeHome,
      isDirectory: async () => false,
    });
    expect(result.untrackedFolders).toBe(0);
    expect(result.unlocatableProjects).toHaveLength(1);
    expect(result.unlocatableProjects[0]?.projectId).toBe(minted.projectId);
    expect(result.unlocatableProjects[0]?.name).toBe(shortProjectId(minted.projectId));

    // Still read-only: the registry is exactly as it was.
    expect(await readFile(registryPath(), 'utf8')).toBe(registryBefore);
  });

  it("does NOT report per-project pending before migration has run when the v1 manifest has project items — reports upgradePending instead, stays read-only", async () => {
    const bytes = Buffer.from('legacy content', 'utf8');
    const manifest = {
      schemaVersion: 1 as const,
      provider: 'claude' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      items: [
        {
          provider: 'claude' as const,
          kind: 'auto-memory' as const,
          scope: 'project' as const,
          logicalId: 'claude/auto-memory/local:some-key/m.md',
          project: { kind: 'local' as const, vendorKey: 'some-key' },
          contentHash: hashBytes(bytes),
          restoreTarget: { base: 'claude-project-memory' as const, relativePath: 'm.md' },
          capturedAt: '2026-01-01T00:00:00.000Z',
          sensitivity: 'private' as const,
        },
      ],
    };
    await writeMemoryManifest({ stackHome, manifest });
    expect(await exists(migrationMarkerPath())).toBe(false);

    const result = await canonicalMemoryStatus(stackHome, { claudeHome });
    expect(result.upgradePending).toBe(true);
    expect(result.projects).toEqual([]);
    expect(result.newProjects).toBe(0);
    expect(result.conflictedProjects).toBe(0);
    expect(result.unlocatableProjects).toEqual([]);
    expect(result.untrackedFolders).toBe(0);

    // Strictly read-only: migration never actually ran because of this check.
    expect(await exists(migrationMarkerPath())).toBe(false);
    expect(await exists(canonicalMainPath())).toBe(false);
  });
});

describe('pushMemoryViaCanonical / pullMemoryViaCanonical (Task 13)', () => {
  const secureKeys = (dir: string) =>
    fileLocalMemoryKeyStore(dir, {
      harden: () => Promise.resolve(true),
      verify: () => Promise.resolve(true),
    });
  const fakeBackup = (): Promise<BackupResult> =>
    Promise.resolve({
      provider: 'claude',
      files: 0,
      projects: 0,
      createdAt: '2026-10-23T00:00:00.000Z',
    });
  const deps = (home: string, backend: RemoteMemoryBackend | null, keysDir: string) => ({
    stackHome: home,
    backend,
    localKeyStore: secureKeys(keysDir),
    runLocalBackup: fakeBackup,
  });

  /** Like the top-level `bindProject`, but against an explicit `home` (for
   * multi-"machine" tests that need more than one stackHome under `root`), and
   * able to force a specific Project ID (simulating two machines that already
   * agree on a project's identity — e.g. via the separate Cloud project-identity
   * reconciliation this task does not touch). */
  const bindProjectAt = async (home: string, dir: string, fixedProjectId?: string) => {
    let registry = await readLocalRegistry(home);
    const minted = resolveOrMintProject(
      registry,
      { kind: 'local', vendorKey: `v-${path.basename(home)}-${path.basename(dir)}` },
      fixedProjectId ? () => fixedProjectId : mintProjectId,
    );
    registry = minted.registry;
    registry = setBinding(registry, {
      projectId: minted.projectId,
      dir,
      boundAt: '2026-10-23T00:00:00.000Z',
      provenance: 'user-map',
    });
    await writeLocalRegistry(home, registry);
    return minted.projectId;
  };

  const writeAutoMemoryAt = async (claudeHomeDir: string, vendorKey: string, name: string, body: string) => {
    const dir = path.join(claudeHomeDir, 'projects', vendorKey, 'memory');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), body, 'utf8');
  };

  it('pushes a native edit on machine A; machine B (a candidate dir whose git remote matches, no Claude files yet) pulls and materializes it', async () => {
    const gitRemote = 'https://github.com/acme/demo.git';
    const identity = canonicalGitIdentity(gitRemote);
    if (!identity) throw new Error('test setup: expected a resolvable git identity');

    const stackHomeA = path.join(root, 'a-stack');
    const claudeHomeA = path.join(root, 'a-claude');
    const projectDirA = path.join(root, 'a-proj');
    await mkdir(projectDirA, { recursive: true });

    let registryA = await readLocalRegistry(stackHomeA);
    const minted = resolveOrMintProject(registryA, identity);
    registryA = minted.registry;
    const projectId = minted.projectId;
    await writeLocalRegistry(stackHomeA, registryA);
    await writeAutoMemoryAt(
      claudeHomeA,
      encodeClaudeProjectKey(path.resolve(projectDirA)),
      'MEMORY.md',
      'hello from A',
    );
    await stageCanonicalMemory(stackHomeA, {
      claudeHome: claudeHomeA,
      projects: [{ dir: projectDirA, gitRemote }],
    });

    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, 'canonical-two-machine');

    const pushOutcome = await pushMemoryViaCanonical(deps(stackHomeA, backend, path.join(root, 'a-keys')), {
      claudeHome: claudeHomeA,
      projects: [{ dir: projectDirA, gitRemote }],
    });
    expect(pushOutcome.status).toBe('pushed');

    // Machine B: the SAME logical project (its registry already agrees on the
    // Project ID — identity reconciliation across machines is a separate, Cloud-
    // side mechanism this task does not touch), a real folder, but NO Claude
    // files materialized there yet — the only way `materializeCanonicalProjects`
    // can locate it is the git-remote candidate match (Task 13 correction 2(b)).
    const stackHomeB = path.join(root, 'b-stack');
    const claudeHomeB = path.join(root, 'b-claude');
    const projectDirB = path.join(root, 'b-proj');
    await mkdir(projectDirB, { recursive: true });
    let registryB = await readLocalRegistry(stackHomeB);
    registryB = resolveOrMintProject(registryB, identity, () => projectId).registry;
    await writeLocalRegistry(stackHomeB, registryB);

    const pullOutcome = await pullMemoryViaCanonical(deps(stackHomeB, backend, path.join(root, 'b-keys')), {
      claudeHome: claudeHomeB,
      projects: [{ dir: projectDirB, gitRemote }],
    });
    expect(pullOutcome.status).toBe('merged');

    const materializedPath = path.join(
      claudeHomeB,
      'projects',
      encodeClaudeProjectKey(path.resolve(projectDirB)),
      'memory',
      'MEMORY.md',
    );
    expect(await readFile(materializedPath, 'utf8')).toBe('hello from A');
  });

  it('pushing again with no changes creates no new generation (no-op)', async () => {
    const projectId = await bindProjectAt(stackHome, projectDir);
    void projectId;
    await mkdir(path.dirname(path.join(projectDir, 'CLAUDE.local.md')), { recursive: true });
    await writeFile(path.join(projectDir, 'CLAUDE.local.md'), 'private memory', 'utf8');
    await stageCanonicalMemory(stackHome, { claudeHome });

    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, 'canonical-noop');
    const keysDir = path.join(root, 'keys');

    const first = await pushMemoryViaCanonical(deps(stackHome, backend, keysDir), { claudeHome });
    expect(first.status).toBe('pushed');
    expect(await backend.listGenerations()).toHaveLength(1);

    const second = await pushMemoryViaCanonical(deps(stackHome, backend, keysDir), { claudeHome });
    expect(second.status).toBe('up-to-date');
    expect(await backend.listGenerations()).toHaveLength(1);
  });

  it('conflicting edits on two machines: the second push reports a conflict and creates no generation (Skills push is a wholly separate call path, unaffected)', async () => {
    const stackHomeX = path.join(root, 'x-stack');
    const claudeHomeX = path.join(root, 'x-claude');
    const projectDirX = path.join(root, 'x-proj');
    await mkdir(projectDirX, { recursive: true });
    const projectId = await bindProjectAt(stackHomeX, projectDirX);
    await writeAutoMemoryAt(claudeHomeX, encodeClaudeProjectKey(path.resolve(projectDirX)), 'MEMORY.md', 'content A');
    await stageCanonicalMemory(stackHomeX, { claudeHome: claudeHomeX });

    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, 'canonical-conflict');
    const pushX = await pushMemoryViaCanonical(deps(stackHomeX, backend, path.join(root, 'x-keys')), {
      claudeHome: claudeHomeX,
    });
    expect(pushX.status).toBe('pushed');

    // Machine Y: the same Project ID (already reconciled), a different edit of
    // the SAME canonical path, made WITHOUT ever pulling X's generation first —
    // Y's base stays null, so pushing goes straight to the merge path against an
    // empty base and collides with X's already-published content.
    const stackHomeY = path.join(root, 'y-stack');
    const claudeHomeY = path.join(root, 'y-claude');
    const projectDirY = path.join(root, 'y-proj');
    await mkdir(projectDirY, { recursive: true });
    await bindProjectAt(stackHomeY, projectDirY, projectId);
    await writeAutoMemoryAt(claudeHomeY, encodeClaudeProjectKey(path.resolve(projectDirY)), 'MEMORY.md', 'content B');
    await stageCanonicalMemory(stackHomeY, { claudeHome: claudeHomeY });

    const pushY = await pushMemoryViaCanonical(deps(stackHomeY, backend, path.join(root, 'y-keys')), {
      claudeHome: claudeHomeY,
    });
    expect(pushY.status).toBe('conflict');
    expect(pushY.conflicts?.[0]?.path).toBe('notes/MEMORY.md');
    // Still only X's one generation — the conflicting push created nothing.
    expect(await backend.listGenerations()).toHaveLength(1);
    // `pushMemoryViaCanonical` takes no Skills dependency at all and never calls
    // anything Skills-related (that remains `cloudApplyPush`, a wholly separate
    // call path wired at `stak push`'s command layer) — a Memory conflict here
    // can only ever block Skills via that outer command's own preflight check,
    // never from inside this function.
  });

  it('a fresh machine\'s full recover restores canonical main but not base; the next canonical pull repairs the base via its no-op merge branch', async () => {
    const stackHomeS = path.join(root, 's-stack');
    const claudeHomeS = path.join(root, 's-claude');
    const projectDirS = path.join(root, 's-proj');
    await mkdir(projectDirS, { recursive: true });
    await bindProjectAt(stackHomeS, projectDirS);
    await writeAutoMemoryAt(claudeHomeS, encodeClaudeProjectKey(path.resolve(projectDirS)), 'MEMORY.md', 'source content');
    await stageCanonicalMemory(stackHomeS, { claudeHome: claudeHomeS });

    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, 'canonical-fresh-machine');
    const pushOutcome = await pushMemoryViaCanonical(deps(stackHomeS, backend, path.join(root, 's-keys')), {
      claudeHome: claudeHomeS,
    });
    expect(pushOutcome.status).toBe('pushed');

    // Fresh machine: the pre-existing, unchanged full v1-style recover path.
    const stackHomeF = path.join(root, 'f-stack');
    const keysF = path.join(root, 'f-keys');
    const recovered = await runMemoryCloudRecover(deps(stackHomeF, backend, keysF));
    expect(recovered.status).toBe('recovered');
    // The v2 bundle restores `canonical/main.json` but never `base.json` (see
    // `bundle-codec.ts` / `modes.ts`'s `cloudRecover` — confirmed directly here).
    expect(await readCanonicalBase(stackHomeF)).toBeNull();

    const claudeHomeF = path.join(root, 'f-claude');
    const pullOutcome = await pullMemoryViaCanonical(deps(stackHomeF, backend, keysF), { claudeHome: claudeHomeF });
    // Local (just restored) already equals remote exactly — nothing to merge.
    expect(pullOutcome.status).toBe('up-to-date');

    const base = await readCanonicalBase(stackHomeF);
    expect(base?.generation).toBe(pushOutcome.generation);
    expect(base?.main).toEqual(await readCanonicalMain(stackHomeF));
  });

  it('a canonical project with no binding and no matching candidate is skipped during materialize and reported as unavailable; nothing is written', async () => {
    let registry = await readLocalRegistry(stackHome);
    const minted = resolveOrMintProject(registry, {
      kind: 'git',
      canonical: 'github.com/acme/ghost',
      host: 'github.com',
      owner: 'acme',
      repo: 'ghost',
    });
    registry = minted.registry;
    await writeLocalRegistry(stackHome, registry);
    await writeCanonicalMain(stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        {
          projectId: minted.projectId,
          documents: [
            {
              path: 'notes/MEMORY.md',
              state: 'present',
              contentHash: hashBytes(Buffer.from('ghost content')),
              importedFrom: 'claude',
              importedAt: '2026-10-23T00:00:00.000Z',
            },
          ],
        },
      ],
    });

    // No binding for this project, and no `projects` candidate shares its git remote.
    const result = await materializeCanonicalProjects(stackHome, { claudeHome });
    expect(result.materialized).toBe(0);
    expect(result.unavailable).toBe(1);
    // Nothing was written anywhere under `claudeHome` — never guess a directory.
    await expect(stat(path.join(claudeHome, 'projects'))).rejects.toThrow();
  });
});
