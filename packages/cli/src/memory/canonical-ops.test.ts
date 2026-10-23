import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CANONICAL_MAIN_SCHEMA_VERSION,
  canonicalDigest,
  canonicalGitIdentity,
  emptyRegistry,
  encodeClaudeProjectKey,
  fetchRemoteCanonical,
  fileLocalMemoryKeyStore,
  generateRecoveryKey,
  gitClaimOf,
  recordFor,
  hashBytes,
  InMemoryRemoteMemoryStore,
  inMemoryRemoteMemoryBackend,
  legacyCompatKey,
  mintProjectId,
  planProjectSync,
  pushCanonicalMemory,
  readCanonicalBase,
  readCanonicalMain,
  readLocalRecoveryState,
  readLocalRegistry,
  readMemoryManifest,
  resolveOrMintProject,
  RemoteMemoryError,
  setBinding,
  shortProjectId,
  standardCloudBackup,
  writeCanonicalBase,
  writeCanonicalMain,
  toPortableSnapshot,
  writeLocalRegistry,
  writeMemoryManifest,
  writeMemoryObject,
  writePortableSnapshot,
  v1ManifestFingerprint,
  type BackupResult,
  type RemoteMemoryBackend,
} from '@stack/memory';

import { renderCombinedPullResult } from '../ui/cloud.js';
import {
  canonicalMemoryStatus,
  diffPendingConflict,
  listPendingConflicts,
  materializeCanonicalProjects,
  materializeMemory,
  resolvePendingConflict,
  migrateWithProjectionSeed,
  pullMemoryViaCanonical,
  pushMemoryViaCanonical,
  stageCanonicalMemory,
} from './canonical-ops.js';
import {
  publishCanonicalGeneration,
  pushStagedMemory,
  runMemoryCloudBackup,
  runMemoryCloudProtect,
  runMemoryCloudRecover,
} from './cloud-ops.js';
import { MemorySyncError } from './pending-merge.js';

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
    await writeLocalRegistry(stackHomeA, registryA);
    // The portable snapshot is what travels in the Cloud bundle (`registryB64`)
    // — write it explicitly so machine B can locate this project WITHOUT ever
    // having locally learned its git claim itself (Task 13 Important-6).
    await writePortableSnapshot(stackHomeA, toPortableSnapshot(registryA));
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

    // Machine B: the SAME logical project, a real folder, but NO Claude files
    // materialized there yet, and — Task 13 Important-6 fix (review round) —
    // its LOCAL registry has NEVER learned this project's git claim at all
    // (completely empty/fresh). The only way `materializeCanonicalProjects` can
    // locate it is the portable registry snapshot that traveled inside the
    // pulled Cloud generation itself, matched against the git-remote candidate
    // (Task 13 correction 2(b) + Important-6).
    const stackHomeB = path.join(root, 'b-stack');
    const claudeHomeB = path.join(root, 'b-claude');
    const projectDirB = path.join(root, 'b-proj');
    await mkdir(projectDirB, { recursive: true });

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

    // Task 13 fix round 2 (Important-4 residual): machine B located and
    // materialized this project purely via the snapshot claim — its local
    // registry must now have LEARNED that git claim too, so a later
    // `stak add .` resolves to the SAME Project ID instead of minting a
    // second, duplicate one for the same repo.
    const registryBAfter = await readLocalRegistry(stackHomeB);
    const recordB = recordFor(registryBAfter, minted.projectId);
    expect(recordB).toBeDefined();
    expect(gitClaimOf(recordB!)?.canonical.toLowerCase()).toBe(identity.canonical.toLowerCase());

    const staged = await stageCanonicalMemory(stackHomeB, {
      claudeHome: claudeHomeB,
      projects: [{ dir: projectDirB, gitRemote }],
    });
    expect(staged.projects).toHaveLength(1);
    expect(staged.projects[0]?.projectId).toBe(minted.projectId);
    const registryBFinal = await readLocalRegistry(stackHomeB);
    expect(registryBFinal.projects.filter((p) => gitClaimOf(p)?.canonical.toLowerCase() === identity.canonical.toLowerCase())).toHaveLength(1);
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

  it('a pure Skills-only account (nothing ever staged, Cloud has no Memory history) does not publish an empty generation (Task 13 Important-7(a))', async () => {
    // Deliberately no `stak add .` ever: no v1 manifest, no canonical content.
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, 'canonical-skills-only');
    const outcome = await pushMemoryViaCanonical(deps(stackHome, backend, path.join(root, 'keys')), { claudeHome });
    expect(outcome.status).toBe('nothing-staged');
    expect(await backend.listGenerations()).toHaveLength(0);
  });

  it('not signed in: push reports `skipped`, never a bogus "already up to date" (Task 13 Minor fix)', async () => {
    const outcome = await pushMemoryViaCanonical(deps(stackHome, null, path.join(root, 'keys')), { claudeHome });
    expect(outcome.status).toBe('skipped');
  });

  it('a publish failure (forced conflict -> retry-exhausted) leaves local canonical main and base UNCHANGED (Task 13 Important-4)', async () => {
    await bindProjectAt(stackHome, projectDir);
    await writeAutoMemoryAt(claudeHome, encodeClaudeProjectKey(path.resolve(projectDir)), 'MEMORY.md', 'content');
    await stageCanonicalMemory(stackHome, { claudeHome });

    const mainBefore = await readCanonicalMain(stackHome);
    expect(await readCanonicalBase(stackHome)).toBeNull();

    const store = new InMemoryRemoteMemoryStore();
    const realBackend = inMemoryRemoteMemoryBackend(store, 'canonical-fail');
    // Delegate every method to the real backend via the prototype chain, except
    // `createGeneration`, which always loses the race — forcing
    // `pushCanonicalMemory` to exhaust all 3 retry attempts.
    const failingBackend = Object.create(realBackend) as RemoteMemoryBackend;
    (failingBackend as { createGeneration: RemoteMemoryBackend['createGeneration'] }).createGeneration = async () => {
      throw new RemoteMemoryError('conflict', 'forced conflict for test');
    };

    const outcome = await pushMemoryViaCanonical(deps(stackHome, failingBackend, path.join(root, 'fail-keys')), {
      claudeHome,
    });
    expect(outcome.status).toBe('retry-exhausted');

    // `publishCanonicalGeneration` must never write `canonical/main.json` before
    // a publish actually succeeds — local main and base move together, ONLY
    // after a successful publish (`pushCanonicalMemory`'s own contract).
    expect(await readCanonicalMain(stackHome)).toEqual(mainBefore);
    expect(await readCanonicalBase(stackHome)).toBeNull();
  });

  it('lost update: B commits between A\'s fetch and A\'s publish — A must conflict and retry/merge, never silently overwrite B (Task 13 fix round 2, Critical-1)', async () => {
    const identity = canonicalGitIdentity('https://github.com/acme/race.git');
    if (!identity) throw new Error('test setup: expected a resolvable git identity');

    // Machine A: push doc a.md as generation 0.
    const stackHomeA = path.join(root, 'race-a');
    let registryA = await readLocalRegistry(stackHomeA);
    const minted = resolveOrMintProject(registryA, identity);
    registryA = minted.registry;
    await writeLocalRegistry(stackHomeA, registryA);
    const projectId = minted.projectId;
    const bodyA1 = Buffer.from('A1', 'utf8');
    const hashA1 = hashBytes(bodyA1);
    await writeCanonicalMain(stackHomeA, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        {
          projectId,
          documents: [
            { path: 'notes/a.md', state: 'present', contentHash: hashA1, importedFrom: 'claude', importedAt: '2026-10-23T00:00:00.000Z' },
          ],
        },
      ],
    });
    await writeMemoryObject({ stackHome: stackHomeA, contentHash: hashA1, bytes: bodyA1 });

    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, 'canonical-race');
    const keysDirA = path.join(root, 'race-a-keys');
    const genA0 = await pushMemoryViaCanonical(deps(stackHomeA, backend, keysDirA), {});
    expect(genA0.status).toBe('pushed');
    expect(genA0.generation).toBe(0);

    // Machine B: the SAME project (pre-reconciled id), pulls A's generation 0,
    // then pushes its OWN doc b.md for real — generation 1, containing both
    // a.md and b.md.
    const stackHomeB = path.join(root, 'race-b');
    let registryB = await readLocalRegistry(stackHomeB);
    registryB = resolveOrMintProject(registryB, identity, () => projectId).registry;
    await writeLocalRegistry(stackHomeB, registryB);
    const keysDirB = path.join(root, 'race-b-keys');
    await pullMemoryViaCanonical(deps(stackHomeB, backend, keysDirB), {});
    const mainB = await readCanonicalMain(stackHomeB);
    const bodyB1 = Buffer.from('B1', 'utf8');
    const hashB1 = hashBytes(bodyB1);
    await writeMemoryObject({ stackHome: stackHomeB, contentHash: hashB1, bytes: bodyB1 });
    await writeCanonicalMain(stackHomeB, {
      ...mainB,
      projects: mainB.projects.map((p) =>
        p.projectId === projectId
          ? {
              ...p,
              documents: [
                ...p.documents,
                { path: 'notes/b.md', state: 'present' as const, contentHash: hashB1, importedFrom: 'claude' as const, importedAt: '2026-10-23T00:00:00.000Z' },
              ],
            }
          : p,
      ),
    });
    const genB1 = await pushMemoryViaCanonical(deps(stackHomeB, backend, keysDirB), {});
    expect(genB1.status).toBe('pushed');
    expect(genB1.generation).toBe(1);

    // Machine A: locally adds its OWN new doc a2.md on top of its stale base
    // (generation 0 — A never learned about B's push). Its OWN `fetchRemote`
    // is forced to report the STALE generation-0 state (simulating "B's push
    // landed on Cloud after A's own fetch already happened, but before A's
    // publish call") — the exact race window Critical-1 is about. Later retry
    // attempts see the real, current remote.
    const bodyA2 = Buffer.from('A2', 'utf8');
    const hashA2 = hashBytes(bodyA2);
    await writeMemoryObject({ stackHome: stackHomeA, contentHash: hashA2, bytes: bodyA2 });
    const mainABeforeA2 = await readCanonicalMain(stackHomeA);
    await writeCanonicalMain(stackHomeA, {
      ...mainABeforeA2,
      projects: mainABeforeA2.projects.map((p) =>
        p.projectId === projectId
          ? {
              ...p,
              documents: [
                ...p.documents,
                { path: 'notes/a2.md', state: 'present' as const, contentHash: hashA2, importedFrom: 'claude' as const, importedAt: '2026-10-23T00:00:00.000Z' },
              ],
            }
          : p,
      ),
    });

    const staleRemote = { generation: 0, main: { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [{ projectId, documents: [{ path: 'notes/a.md', state: 'present' as const, contentHash: hashA1, importedFrom: 'claude' as const, importedAt: '2026-10-23T00:00:00.000Z' }] }] } };
    let fetchCount = 0;
    const depsA = deps(stackHomeA, backend, keysDirA);
    const outcome = await pushCanonicalMemory({
      getLocalMain: () => readCanonicalMain(stackHomeA),
      getBase: () => readCanonicalBase(stackHomeA),
      setLocalMain: (main) => writeCanonicalMain(stackHomeA, main),
      setBase: (base) => writeCanonicalBase(stackHomeA, base),
      fetchRemote: async () => {
        fetchCount += 1;
        if (fetchCount === 1) return staleRemote; // the race: stale by the time publish() runs
        const result = await fetchRemoteCanonical({ backend, localRegistry: await readLocalRegistry(stackHomeA) });
        if (!result) return null;
        // Mirrors `canonical-ops.ts`'s `remoteOf`: persist fetched objects
        // locally so a later merge/materialize can actually read B's content.
        for (const object of result.objects)
          await writeMemoryObject({ stackHome: stackHomeA, contentHash: object.contentHash, bytes: object.bytes });
        return { generation: result.generation, main: result.main };
      },
      publish: async (main, expectedParent) => {
        const result = await publishCanonicalGeneration(depsA, main, expectedParent);
        return { generation: result.generation };
      },
      savePendingMerge: async () => undefined,
      clearPendingMerge: async () => undefined,
    });

    expect(outcome.status).toBe('pushed');
    // B's doc must survive — never silently overwritten by A's stale-based publish.
    const finalMain = await readCanonicalMain(stackHomeA);
    const docs = finalMain.projects.find((p) => p.projectId === projectId)?.documents ?? [];
    expect(docs.some((d) => d.state === 'present' && d.contentHash === hashA1)).toBe(true);
    expect(docs.some((d) => d.state === 'present' && d.contentHash === hashA2)).toBe(true);
    expect(docs.some((d) => d.state === 'present' && d.contentHash === hashB1)).toBe(true);
    // And the actually-published generation on Cloud carries all three, too.
    const remoteAfter = await fetchRemoteCanonical({ backend, localRegistry: await readLocalRegistry(stackHomeA) });
    const remoteDocs = remoteAfter?.main.projects.find((p) => p.projectId === projectId)?.documents ?? [];
    expect(remoteDocs.some((d) => d.state === 'present' && d.contentHash === hashB1)).toBe(true);
  });

  it('spec Appendix A.4 / Task 13 fix round 2, finding 7: a v1 user with unpushed edits whose Cloud latest is their OWN last push gets a clean push with no false conflicts; another machine\'s later change still merges correctly', async () => {
    const identity = canonicalGitIdentity('https://github.com/acme/v1-conflict.git');
    if (!identity) throw new Error('test setup: expected a resolvable git identity');

    // Machine A: a genuine v1 account. Push via the OLD v1 path (`pushStagedMemory`,
    // which also records provenance — `recoveredGeneration` — exactly like a
    // real pre-canonical CLI would).
    const stackHomeA = path.join(root, 'v1gen-a-stack');
    const bodyOriginal = Buffer.from('original note', 'utf8');
    const hashOriginal = hashBytes(bodyOriginal);
    await writeMemoryObject({ stackHome: stackHomeA, contentHash: hashOriginal, bytes: bodyOriginal });
    await writeMemoryManifest({
      stackHome: stackHomeA,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-23T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/v1-conflict/a.md',
            project: {
              kind: 'git',
              canonical: 'github.com/acme/v1-conflict',
              host: 'github.com',
              owner: 'acme',
              repo: 'v1-conflict',
            },
            contentHash: hashOriginal,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
            capturedAt: '2026-10-23T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });

    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, 'canonical-v1-gen7');
    const keysDirA = path.join(root, 'v1gen-a-keys');
    const v1Push = await pushStagedMemory({
      stackHome: stackHomeA,
      backend,
      localKeyStore: fileLocalMemoryKeyStore(keysDirA, { harden: () => Promise.resolve(true), verify: () => Promise.resolve(true) }),
      runLocalBackup: () => Promise.resolve({ provider: 'claude', files: 1, projects: 1, createdAt: '2026-10-23T00:00:00.000Z' }),
    });
    expect(v1Push.status).toBe('standard');
    const latestAfterV1Push = await backend.getLatest();
    expect(latestAfterV1Push?.bundleFormatVersion).toBe('stack-mem-bundle-v1');

    // Machine A now makes an UNPUSHED edit locally (e.g. via `stak add .` after
    // editing the native file) — the v1 manifest's own content changes, but
    // nothing has been pushed again yet.
    const bodyEdited = Buffer.from('edited note, never pushed', 'utf8');
    const hashEdited = hashBytes(bodyEdited);
    await writeMemoryObject({ stackHome: stackHomeA, contentHash: hashEdited, bytes: bodyEdited });
    await writeMemoryManifest({
      stackHome: stackHomeA,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-23T00:00:01.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/v1-conflict/a.md',
            project: {
              kind: 'git',
              canonical: 'github.com/acme/v1-conflict',
              host: 'github.com',
              owner: 'acme',
              repo: 'v1-conflict',
            },
            contentHash: hashEdited,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
            capturedAt: '2026-10-23T00:00:01.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });

    // The canonical-aware push: migrates locally (building `main` from the
    // EDITED v1 manifest), and must seed `base` from generation 0 (this
    // machine's own last v1 push) before merging — a clean fast-forward, not
    // a false `edit-edit` conflict against an empty base.
    const pushOutcome = await pushMemoryViaCanonical(deps(stackHomeA, backend, keysDirA), {});
    expect(pushOutcome.status).toBe('pushed');
    expect(pushOutcome.generation).toBe(1);
    const mainAfter = await readCanonicalMain(stackHomeA);
    const projectIdFromA = mainAfter.projects[0]!.projectId;
    expect(
      mainAfter.projects[0]?.documents.some((d) => d.state === 'present' && d.contentHash === hashEdited),
    ).toBe(true);

    // Another machine, pushing AFTER that generation, still merges correctly.
    const stackHomeB = path.join(root, 'v1gen-b-stack');
    let registryB = await readLocalRegistry(stackHomeB);
    registryB = resolveOrMintProject(registryB, identity, () => projectIdFromA).registry;
    await writeLocalRegistry(stackHomeB, registryB);
    const keysDirB = path.join(root, 'v1gen-b-keys');
    const pulledB = await pullMemoryViaCanonical(deps(stackHomeB, backend, keysDirB), {});
    expect(pulledB.status).toBe('merged');
    const mainB = await readCanonicalMain(stackHomeB);
    const bodyFromB = Buffer.from('a brand new doc from B', 'utf8');
    const hashFromB = hashBytes(bodyFromB);
    await writeMemoryObject({ stackHome: stackHomeB, contentHash: hashFromB, bytes: bodyFromB });
    await writeCanonicalMain(stackHomeB, {
      ...mainB,
      projects: mainB.projects.map((p) =>
        p.projectId === projectIdFromA
          ? {
              ...p,
              documents: [
                ...p.documents,
                { path: 'notes/b.md', state: 'present' as const, contentHash: hashFromB, importedFrom: 'claude' as const, importedAt: '2026-10-23T00:00:02.000Z' },
              ],
            }
          : p,
      ),
    });
    const pushedB = await pushMemoryViaCanonical(deps(stackHomeB, backend, keysDirB), {});
    expect(pushedB.status).toBe('pushed');
    expect(pushedB.generation).toBe(2);
    const finalRemote = await fetchRemoteCanonical({ backend, localRegistry: await readLocalRegistry(stackHomeB) });
    const finalDocs = finalRemote?.main.projects.find((p) => p.projectId === projectIdFromA)?.documents ?? [];
    expect(finalDocs.some((d) => d.state === 'present' && d.contentHash === hashEdited)).toBe(true);
    expect(finalDocs.some((d) => d.state === 'present' && d.contentHash === hashFromB)).toBe(true);
  });

  it('a Protected account this device cannot unlock reports a friendly `protected-locked` status for both push and pull, never a thrown/FAILED error (Task 13 Important-7(b))', async () => {
    await bindProjectAt(stackHome, projectDir);
    await writeAutoMemoryAt(claudeHome, encodeClaudeProjectKey(path.resolve(projectDir)), 'MEMORY.md', 'content');
    await stageCanonicalMemory(stackHome, { claudeHome });

    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, 'canonical-protected-locked');
    await backend.setPrivacyMode('protected');

    // This device holds no MMK at all (never protected from here, no recovery).
    const lockedKeysDir = path.join(root, 'locked-keys');
    const pushOutcome = await pushMemoryViaCanonical(deps(stackHome, backend, lockedKeysDir), { claudeHome });
    expect(pushOutcome.status).toBe('protected-locked');

    const pullOutcome = await pullMemoryViaCanonical(deps(stackHome, backend, lockedKeysDir), { claudeHome });
    expect(pullOutcome.status).toBe('protected-locked');
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

  it('a fresh machine\'s full recover restores canonical main but not base; the next canonical pull repairs the base via its no-op merge branch, and materializes CLAUDE.local.md + agent memory to disk (Task 13 Critical-1)', async () => {
    const stackHomeS = path.join(root, 's-stack');
    const claudeHomeS = path.join(root, 's-claude');
    const projectDirS = path.join(root, 's-proj');
    await mkdir(projectDirS, { recursive: true });
    const projectId = await bindProjectAt(stackHomeS, projectDirS);
    await writeAutoMemoryAt(claudeHomeS, encodeClaudeProjectKey(path.resolve(projectDirS)), 'MEMORY.md', 'source content');
    // Private instructions (`instructions/private.md`) and agent-specific memory
    // (`agents/<agent>/...`) — exactly the two namespaces Critical-1 found
    // silently lost on a fresh machine (a bare `notes/` doc alone didn't expose
    // the bug: it only showed up once the fresh machine's projection was
    // wrongly seeded P = C for ALL recovered documents, reading "native file
    // absent" as "deleted since last sync" for every one of them).
    await writeFile(path.join(projectDirS, 'CLAUDE.local.md'), 'private instructions', 'utf8');
    await mkdir(path.join(projectDirS, '.claude', 'agent-memory', 'claude'), { recursive: true });
    await writeFile(
      path.join(projectDirS, '.claude', 'agent-memory', 'claude', 'notes.md'),
      'agent-specific memory',
      'utf8',
    );
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

    // F has the project's directory (e.g. via `stak project map`, same as any
    // other "project exists on this machine" case) but has NEVER written any
    // Claude files for it — exactly the fresh-machine scenario spec §5
    // describes ("STAK writes it into Claude's files for each project that
    // exists on this machine").
    const claudeHomeF = path.join(root, 'f-claude');
    const projectDirF = path.join(root, 'f-proj');
    await mkdir(projectDirF, { recursive: true });
    await bindProjectAt(stackHomeF, projectDirF, projectId);

    const pullOutcome = await pullMemoryViaCanonical(deps(stackHomeF, backend, keysF), { claudeHome: claudeHomeF });
    // Local (just restored) already equals remote exactly — nothing to merge.
    expect(pullOutcome.status).toBe('up-to-date');

    const base = await readCanonicalBase(stackHomeF);
    expect(base?.generation).toBe(pushOutcome.generation);
    expect(base?.main).toEqual(await readCanonicalMain(stackHomeF));

    // The actual Critical-1 assertion: materialize must WRITE these files, not
    // silently plan them as `import-delete` because the projection was wrongly
    // seeded P = C for documents this machine never natively had.
    expect(
      await readFile(path.join(projectDirF, 'CLAUDE.local.md'), 'utf8'),
    ).toBe('private instructions');
    expect(
      await readFile(
        path.join(projectDirF, '.claude', 'agent-memory', 'claude', 'notes.md'),
        'utf8',
      ),
    ).toBe('agent-specific memory');
    expect(
      await readFile(
        path.join(claudeHomeF, 'projects', encodeClaudeProjectKey(path.resolve(projectDirF)), 'memory', 'MEMORY.md'),
        'utf8',
      ),
    ).toBe('source content');
  });

  it('a fresh machine whose Cloud latest is STILL v1 (never canonically pushed): recover, then pull — CLAUDE.local.md and .claude/agent-memory/* are still written to disk (Task 13 fix round 2, finding 5 — "C1 residual")', async () => {
    // Source machine: a GENUINE v1 manifest with project-scope items (auto-
    // memory, private instructions, agent memory), pushed via the OLD v1
    // Standard path directly — `canonical/main.json` never gets built or
    // published on the source machine at all. This is a pure Skills+v1-Memory
    // account that has never run a canonical-aware `stak push`.
    const identity = canonicalGitIdentity('https://github.com/acme/v1-only.git');
    if (!identity) throw new Error('test setup: expected a resolvable git identity');
    const stackHomeS = path.join(root, 'v1only-s-stack');
    const bodyNotes = Buffer.from('source content', 'utf8');
    const bodyPrivate = Buffer.from('private instructions', 'utf8');
    const bodyAgent = Buffer.from('agent-specific memory', 'utf8');
    const hashNotes = hashBytes(bodyNotes);
    const hashPrivate = hashBytes(bodyPrivate);
    const hashAgent = hashBytes(bodyAgent);
    await writeMemoryObject({ stackHome: stackHomeS, contentHash: hashNotes, bytes: bodyNotes });
    await writeMemoryObject({ stackHome: stackHomeS, contentHash: hashPrivate, bytes: bodyPrivate });
    await writeMemoryObject({ stackHome: stackHomeS, contentHash: hashAgent, bytes: bodyAgent });
    await writeMemoryManifest({
      stackHome: stackHomeS,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-23T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/v1-only/MEMORY.md',
            project: {
              kind: 'git',
              canonical: 'github.com/acme/v1-only',
              host: 'github.com',
              owner: 'acme',
              repo: 'v1-only',
            },
            contentHash: hashNotes,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'MEMORY.md' },
            capturedAt: '2026-10-23T00:00:00.000Z',
            sensitivity: 'private',
          },
          {
            provider: 'claude',
            kind: 'project-private-instructions',
            scope: 'project',
            logicalId: 'claude/project-private-instructions/github.com/acme/v1-only',
            project: {
              kind: 'git',
              canonical: 'github.com/acme/v1-only',
              host: 'github.com',
              owner: 'acme',
              repo: 'v1-only',
            },
            contentHash: hashPrivate,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'CLAUDE.local.md' },
            capturedAt: '2026-10-23T00:00:00.000Z',
            sensitivity: 'private',
          },
          {
            provider: 'claude',
            kind: 'agent-memory',
            scope: 'project',
            logicalId: 'claude/agent-memory/github.com/acme/v1-only/.claude/agent-memory/claude/notes.md',
            project: {
              kind: 'git',
              canonical: 'github.com/acme/v1-only',
              host: 'github.com',
              owner: 'acme',
              repo: 'v1-only',
            },
            contentHash: hashAgent,
            restoreTarget: {
              base: 'claude-project-memory',
              relativePath: '.claude/agent-memory/claude/notes.md',
            },
            capturedAt: '2026-10-23T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });

    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, 'canonical-v1-only-fresh-machine');
    // A genuine v1 push — NOT through the canonical engine at all.
    const pushed = await standardCloudBackup({ stackHome: stackHomeS, backend });
    const latest = await backend.getLatest();
    expect(latest?.bundleFormatVersion).toBe('stack-mem-bundle-v1');
    void pushed;

    // Fresh machine: the pre-existing, unchanged full v1-style recover path —
    // restores the v1 manifest (project items included; it was never slimmed,
    // since this account never migrated).
    const stackHomeF = path.join(root, 'v1only-f-stack');
    const keysF = path.join(root, 'v1only-f-keys');
    const recovered = await runMemoryCloudRecover(deps(stackHomeF, backend, keysF));
    expect(recovered.status).toBe('recovered');

    // F has the project's directory but has NEVER written any Claude files
    // for it yet.
    const claudeHomeF = path.join(root, 'v1only-f-claude');
    const projectDirF = path.join(root, 'v1only-f-proj');
    await mkdir(projectDirF, { recursive: true });
    let registryF = await readLocalRegistry(stackHomeF);
    registryF = resolveOrMintProject(registryF, identity).registry;
    await writeLocalRegistry(stackHomeF, registryF);

    const pullOutcome = await pullMemoryViaCanonical(deps(stackHomeF, backend, keysF), {
      claudeHome: claudeHomeF,
      projects: [{ dir: projectDirF, gitRemote: 'https://github.com/acme/v1-only.git' }],
    });
    expect(pullOutcome.status === 'up-to-date' || pullOutcome.status === 'merged').toBe(true);

    // The actual finding-5 assertion: migration built `main` from the
    // RECOVERED v1 manifest (since `needsBuild` is true — this account's v1
    // manifest genuinely has project items) — the projection must NOT have
    // been seeded P = C for documents this fresh machine's native files never
    // held, or materialize would have silently planned them as `import-delete`
    // instead of writing them out.
    expect(
      await readFile(path.join(projectDirF, 'CLAUDE.local.md'), 'utf8'),
    ).toBe('private instructions');
    expect(
      await readFile(
        path.join(projectDirF, '.claude', 'agent-memory', 'claude', 'notes.md'),
        'utf8',
      ),
    ).toBe('agent-specific memory');
    expect(
      await readFile(
        path.join(claudeHomeF, 'projects', encodeClaudeProjectKey(path.resolve(projectDirF)), 'memory', 'MEMORY.md'),
        'utf8',
      ),
    ).toBe('source content');
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
    // Task 13 Important-5 fix (review round): `unavailable` now names each
    // unlocatable project (spec §4.5), not just a count.
    expect(result.unavailable).toHaveLength(1);
    expect(result.unavailable[0]?.projectId).toBe(minted.projectId);
    // Nothing was written anywhere under `claudeHome` — never guess a directory.
    await expect(stat(path.join(claudeHome, 'projects'))).rejects.toThrow();
  });
});

describe('Task 13 fix round 3', () => {
  const secureKeys = (dir: string) =>
    fileLocalMemoryKeyStore(dir, {
      harden: () => Promise.resolve(true),
      verify: () => Promise.resolve(true),
    });
  const fakeBackup = (): Promise<BackupResult> =>
    Promise.resolve({ provider: 'claude', files: 0, projects: 0, createdAt: '2026-10-23T00:00:00.000Z' });
  const deps = (home: string, backend: RemoteMemoryBackend | null, keysDir: string) => ({
    stackHome: home,
    backend,
    localKeyStore: secureKeys(keysDir),
    runLocalBackup: fakeBackup,
  });

  describe('B: Skills-only account never publishes a Memory generation', () => {
    it('push then push: zero generations', async () => {
      const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r3-skills-push-push');
      const keys = path.join(root, 'keys');
      expect((await pushMemoryViaCanonical(deps(stackHome, backend, keys), { claudeHome })).status).toBe('nothing-staged');
      // Migration has now written an empty manifests/current.json and its
      // completion marker — the second push must still publish nothing.
      expect(await exists(migrationMarkerPath())).toBe(true);
      expect((await pushMemoryViaCanonical(deps(stackHome, backend, keys), { claudeHome })).status).toBe('nothing-staged');
      expect(await backend.listGenerations()).toHaveLength(0);
      expect(await backend.getProfile()).toBeNull();
    });

    it('pull then push: zero generations', async () => {
      const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r3-skills-pull-push');
      const keys = path.join(root, 'keys');
      expect((await pullMemoryViaCanonical(deps(stackHome, backend, keys), { claudeHome })).status).toBe('up-to-date');
      expect((await pushMemoryViaCanonical(deps(stackHome, backend, keys), { claudeHome })).status).toBe('nothing-staged');
      expect(await backend.listGenerations()).toHaveLength(0);
    });

    it('`stak memory backup` twice: zero generations', async () => {
      const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r3-skills-backup');
      const keys = path.join(root, 'keys');
      expect((await runMemoryCloudBackup(deps(stackHome, backend, keys))).cloud.status).toBe('nothing-staged');
      expect((await runMemoryCloudBackup(deps(stackHome, backend, keys))).cloud.status).toBe('nothing-staged');
      expect(await backend.listGenerations()).toHaveLength(0);
    });
  });

  describe('C: projection seeding for an ESTABLISHED v1 upgrader (spec §9.1 step 4)', () => {
    const gitRemote = 'https://github.com/acme/established.git';
    const git = { kind: 'git' as const, canonical: 'github.com/acme/established', host: 'github.com', owner: 'acme', repo: 'established' };

    /** A v1 user's machine: `stak add` captured a.md and b.md FROM this
     * machine's native files (local manifest). Since then the user edited
     * a.md and deleted b.md natively, without running `stak add`. */
    const establishedV1Machine = async () => {
      const nativeDir = path.join(claudeHome, 'projects', encodeClaudeProjectKey(path.resolve(projectDir)), 'memory');
      await mkdir(nativeDir, { recursive: true });
      const items = [];
      for (const name of ['a.md', 'b.md']) {
        const body = Buffer.from(`captured ${name}`, 'utf8');
        await writeMemoryObject({ stackHome, contentHash: hashBytes(body), bytes: body });
        items.push({
          provider: 'claude' as const,
          kind: 'auto-memory' as const,
          scope: 'project' as const,
          logicalId: `claude/auto-memory/github.com/acme/established/${name}`,
          project: git,
          contentHash: hashBytes(body),
          restoreTarget: { base: 'claude-project-memory' as const, relativePath: name },
          capturedAt: '2026-10-20T00:00:00.000Z',
          sensitivity: 'private' as const,
        });
      }
      await writeMemoryManifest({
        stackHome,
        manifest: { schemaVersion: 1, provider: 'claude', createdAt: '2026-10-20T00:00:00.000Z', items },
      });
      await writeFile(path.join(nativeDir, 'a.md'), 'edited since add', 'utf8');
      // b.md: deleted natively (never written here).
      return { nativeDir, discovery: { claudeHome, projects: [{ dir: projectDir, gitRemote }] } };
    };

    const assertNormalChanges = async (nativeDir: string, discovery: { claudeHome: string; projects: { dir: string; gitRemote: string }[] }) => {
      // The edit is NOT overwritten; the file deleted before the upgrade is
      // RESTORED from STAK (fix round 4: never silently recorded as a deletion).
      expect(await readFile(path.join(nativeDir, 'a.md'), 'utf8')).toBe('edited since add');
      expect(await readFile(path.join(nativeDir, 'b.md'), 'utf8')).toBe('captured b.md');
      // The edit is an ordinary pending import, never a conflict.
      const status = await canonicalMemoryStatus(stackHome, discovery);
      expect(status.projects).toHaveLength(1);
      expect(status.projects[0]?.conflicts).toEqual([]);
      expect(status.projects[0]?.pending).toBe(1);
      const staged = await stageCanonicalMemory(stackHome, discovery);
      expect(staged.projects[0]?.imported).toEqual(['notes/a.md']);
      const docs = (await readCanonicalMain(stackHome)).projects[0]?.documents ?? [];
      expect(docs.find((d) => d.path === 'notes/a.md')).toMatchObject({ state: 'present', contentHash: hashBytes(Buffer.from('edited since add')) });
      expect(docs.find((d) => d.path === 'notes/b.md')).toMatchObject({ state: 'present', contentHash: hashBytes(Buffer.from('captured b.md')) });
    };

    it('first migration via `stak pull`: an edited file is an import-edit (not a conflict); a file absent natively is planned as a materialize-write (not an import-delete) and restored, with a count', async () => {
      const { nativeDir, discovery } = await establishedV1Machine();
      const projectId = (await (async () => {
        await migrateWithProjectionSeed(stackHome, discovery);
        return (await readCanonicalMain(stackHome)).projects[0]!.projectId;
      })());
      // The plan right after migration: b.md -> materialize write, a.md -> import-edit.
      const plan = await planProjectSync({ projectId, dir: projectDir }, stackHome, {
        claudeHome,
        projects: [{ dir: projectDir, gitRemote }],
        resolveProjectId: () => projectId,
      });
      const kindOf = (p: string) => plan.actions.find((x) => 'path' in x && x.path === p)?.kind;
      expect(kindOf('notes/a.md')).toBe('import-edit');
      expect(kindOf('notes/b.md')).toMatch(/^materialize/);
      expect(plan.actions.some((x) => x.kind === 'import-delete')).toBe(false);
      void nativeDir;
    });

    it('`stak pull` as the first migrating command restores the absent file and reports "restored from STAK"', async () => {
      const { nativeDir, discovery } = await establishedV1Machine();
      const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r4-established-pull');
      const pulled = await pullMemoryViaCanonical(deps(stackHome, backend, path.join(root, 'keys')), discovery);
      expect(pulled.status).toBe('up-to-date');
      expect(pulled.conflicts ?? []).toEqual([]);
      expect(pulled.restoredFromStak).toBe(1);
      expect(renderCombinedPullResult({ status: 'noop' }, { status: 'not-attempted' }, { status: 'applied', outcome: pulled })).toContain(
        '1 Memory file(s) will be restored from STAK',
      );
      await assertNormalChanges(nativeDir, discovery);
    });

    it('first migration via `stak memory backup` (with the injected projection-seeding migrate) also seeds', async () => {
      const { nativeDir, discovery } = await establishedV1Machine();
      const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r3-established-backup');
      const keys = path.join(root, 'keys');
      const backedUp = await runMemoryCloudBackup(deps(stackHome, backend, keys), {
        migrate: (home) => migrateWithProjectionSeed(home, discovery),
      });
      expect(backedUp.cloud.status).toBe('standard');
      await pullMemoryViaCanonical(deps(stackHome, backend, keys), discovery);
      await assertNormalChanges(nativeDir, discovery);
    });

    it('the default `stak memory backup` migrate (no locator) seeds nothing: safe — nothing is deleted or overwritten', async () => {
      const { nativeDir, discovery } = await establishedV1Machine();
      const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r3-established-backup-default');
      const keys = path.join(root, 'keys');
      await runMemoryCloudBackup(deps(stackHome, backend, keys));
      await pullMemoryViaCanonical(deps(stackHome, backend, keys), discovery);
      expect(await readFile(path.join(nativeDir, 'a.md'), 'utf8')).toBe('edited since add'); // first-sighting conflict, never overwritten
      expect(await readFile(path.join(nativeDir, 'b.md'), 'utf8')).toBe('captured b.md'); // restored
      const status = await canonicalMemoryStatus(stackHome, discovery);
      expect(status.projects[0]?.conflicts.map((c) => c.path)).toEqual(['notes/a.md']);
    });

    it('a Cloud recover on this CLI records the manifest fingerprint that marks it as Cloud-origin', async () => {
      await establishedV1Machine();
      const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r3-recover-fingerprint');
      await standardCloudBackup({ stackHome, backend });
      const fresh = path.join(root, 'fp-fresh');
      expect((await runMemoryCloudRecover(deps(fresh, backend, path.join(root, 'fp-keys')))).status).toBe('recovered');
      const state = await readLocalRecoveryState(fresh);
      const manifest = await readMemoryManifest(fresh);
      expect(state?.recoveredManifestFingerprint).toBe(v1ManifestFingerprint(manifest!));
    });
  });

  describe('A: an interrupted `stak memory protect` fails closed, and re-running it completes', () => {
    it('resume from a DIFFERENT device (no key from the interrupted run): orphaned replicas are retired, every original re-replicated, latest is the newest original\'s replica (fix round 4)', async () => {
      await bindProject(projectDir);
      const memoryKey = encodeClaudeProjectKey(path.resolve(projectDir));
      await writeAutoMemory(memoryKey, 'MEMORY.md', 'first');
      await stageCanonicalMemory(stackHome, { claudeHome });
      const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r4-protect-other-device');
      const keys = path.join(root, 'keys');
      expect((await pushMemoryViaCanonical(deps(stackHome, backend, keys), { claudeHome })).status).toBe('pushed');
      await writeAutoMemory(memoryKey, 'MEMORY.md', 'second');
      await stageCanonicalMemory(stackHome, { claudeHome });
      expect((await pushMemoryViaCanonical(deps(stackHome, backend, keys), { claudeHome })).status).toBe('pushed');
      const [newest] = await backend.listGenerations();

      // Device 1 replicates the oldest original, then drops off.
      let creates = 0;
      const flaky: RemoteMemoryBackend = Object.create(backend);
      flaky.createGeneration = async (input) => {
        creates += 1;
        if (creates === 2) throw new Error('wifi lost');
        return backend.createGeneration(input);
      };
      await expect(
        runMemoryCloudProtect({ ...deps(stackHome, flaky, keys), backend: flaky }, { recoveryKey: generateRecoveryKey() }),
      ).rejects.toThrow('wifi lost');
      const orphan = (await backend.listGenerations()).find((g) => g.replicaOf)!;
      expect(orphan).toBeDefined();

      // Device 2: different stack home and key store, never had device 1's key.
      const home2 = path.join(root, 'device-2');
      const keys2 = path.join(root, 'keys-2');
      const result = await runMemoryCloudProtect({ ...deps(home2, backend, keys2), backend }, { recoveryKey: generateRecoveryKey() });
      expect(result).toMatchObject({ status: 'protected', migrated: 2 });
      expect((await backend.getProfile())?.privacyMode).toBe('protected');
      const committed = await backend.listGenerations();
      expect(committed.some((g) => g.backupId === orphan.backupId)).toBe(false);
      expect(committed.every((g) => g.privacyMode === 'protected')).toBe(true);
      expect((await backend.getLatest())?.replicaOf).toBe(newest!.backupId);
      // Device 2's key opens the latest Memory.
      const recovered = await runMemoryCloudRecover(deps(path.join(root, 'device-2-restore'), backend, keys2));
      expect(recovered.status).toBe('recovered');
    });

    it('pull and push fail closed (no merge, no native writes or deletes, no generation); re-running protect resumes and finalizes', async () => {
      await bindProject(projectDir);
      await writeFile(path.join(projectDir, 'CLAUDE.local.md'), 'private', 'utf8');
      await writeAutoMemory(encodeClaudeProjectKey(path.resolve(projectDir)), 'MEMORY.md', 'notes body');
      await stageCanonicalMemory(stackHome, { claudeHome });
      const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r3-protect-interrupted');
      const keys = path.join(root, 'keys');
      expect((await pushMemoryViaCanonical(deps(stackHome, backend, keys), { claudeHome })).status).toBe('pushed');

      // Interrupt protect after the replica is committed and the original
      // retired, right before the account is finalized as Protected.
      const interrupted: RemoteMemoryBackend = Object.create(backend);
      interrupted.setPrivacyMode = () => Promise.reject(new Error('connection reset'));
      await expect(
        runMemoryCloudProtect({ ...deps(stackHome, interrupted, keys), backend: interrupted }, { recoveryKey: generateRecoveryKey() }),
      ).rejects.toThrow('connection reset');
      expect((await backend.getProfile())?.privacyMode).toBe('standard');
      expect((await backend.getLatest())?.replicaOf).toBeTruthy();
      // The failed run's recovery wrapper (its file was never written) is revoked.
      expect(await backend.listRecoveryMethods()).toHaveLength(0);
      const generationsBefore = (await backend.listGenerations()).length;

      // The user deletes a native file meanwhile; a fail-closed pull must
      // neither merge nor materialize anything (no re-write, no delete).
      await rm(path.join(projectDir, 'CLAUDE.local.md'));
      const memoryFile = path.join(claudeHome, 'projects', encodeClaudeProjectKey(path.resolve(projectDir)), 'memory', 'MEMORY.md');
      const mainBefore = await readFile(canonicalMainPath(), 'utf8');
      await expect(pullMemoryViaCanonical(deps(stackHome, backend, keys), { claudeHome })).rejects.toMatchObject({
        code: 'protect-in-progress',
        message: expect.stringContaining('stak memory protect'),
      });
      await expect(pushMemoryViaCanonical(deps(stackHome, backend, keys), { claudeHome })).rejects.toMatchObject({
        code: 'protect-in-progress',
      });
      const backup = await runMemoryCloudBackup(deps(stackHome, backend, keys));
      expect(backup.cloud).toMatchObject({ status: 'failed', message: expect.stringContaining('stak memory protect') });
      expect(await exists(path.join(projectDir, 'CLAUDE.local.md'))).toBe(false);
      expect(await readFile(memoryFile, 'utf8')).toBe('notes body');
      expect(await readFile(canonicalMainPath(), 'utf8')).toBe(mainBefore);
      expect(await backend.listGenerations()).toHaveLength(generationsBefore);
      // Recover is gated too (fix round 4).
      await expect(runMemoryCloudRecover(deps(path.join(root, 'other-machine'), backend, keys))).rejects.toMatchObject({
        code: 'protect-in-progress',
      });

      // The originals are already retired, so ANOTHER device (no key) can't
      // finish: refused up front with the accurate message, nothing enrolled,
      // no wrapper added.
      const otherKeys = path.join(root, 'other-keys');
      await expect(
        runMemoryCloudProtect({ ...deps(stackHome, backend, otherKeys), backend }, { recoveryKey: generateRecoveryKey() }),
      ).rejects.toMatchObject({ code: 'protect-in-progress', message: expect.stringContaining('machine that started it') });
      expect(await secureKeys(otherKeys).hasKey()).toBe(false);
      expect(await backend.listRecoveryMethods()).toHaveLength(0);

      // Re-run protect: resumes with this device's key and finalizes.
      const resumed = await runMemoryCloudProtect({ ...deps(stackHome, backend, keys), backend }, { recoveryKey: generateRecoveryKey() });
      expect(resumed).toMatchObject({ status: 'protected', migrated: 0 });
      expect((await backend.getProfile())?.privacyMode).toBe('protected');
      expect(await backend.listRecoveryMethods()).toHaveLength(1);
      const pulled = await pullMemoryViaCanonical(deps(stackHome, backend, keys), { claudeHome });
      expect(pulled.status).toBe('up-to-date');
      expect(await readFile(memoryFile, 'utf8')).toBe('notes body');
    });
  });
});

describe('Task 13 fix round 3 (Minors)', () => {
  const secureKeys = (dir: string) =>
    fileLocalMemoryKeyStore(dir, {
      harden: () => Promise.resolve(true),
      verify: () => Promise.resolve(true),
    });
  const fakeBackup = (): Promise<BackupResult> =>
    Promise.resolve({ provider: 'claude', files: 0, projects: 0, createdAt: '2026-10-23T00:00:00.000Z' });
  const deps = (home: string, backend: RemoteMemoryBackend | null, keysDir: string) => ({
    stackHome: home,
    backend,
    localKeyStore: secureKeys(keysDir),
    runLocalBackup: fakeBackup,
  });
  const doc = async (home: string, body: string) => {
    const bytes = Buffer.from(body, 'utf8');
    await writeMemoryObject({ stackHome: home, contentHash: hashBytes(bytes), bytes });
    return { path: 'notes/n.md', state: 'present' as const, contentHash: hashBytes(bytes), importedFrom: 'claude' as const, importedAt: '2026-10-23T00:00:00.000Z' };
  };

  it('a snapshot-only claim never locates into a directory that is already another project\'s write target', async () => {
    const boundId = await bindProject(projectDir);
    const gitRemote = 'https://github.com/acme/collide.git';
    const identity = canonicalGitIdentity(gitRemote)!;
    const snapshotOnlyId = mintProjectId();
    const snapshot = toPortableSnapshot(resolveOrMintProject(emptyRegistry(), identity, () => snapshotOnlyId).registry);
    await writeCanonicalMain(stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        { projectId: boundId, documents: [await doc(stackHome, 'bound project')] },
        { projectId: snapshotOnlyId, documents: [await doc(stackHome, 'snapshot project')] },
      ],
    });
    const outcome = await materializeCanonicalProjects(stackHome, {
      claudeHome,
      projects: [{ dir: projectDir, gitRemote }],
      remoteRegistrySnapshot: snapshot,
    });
    expect(outcome.unavailable.map((p) => p.projectId)).toEqual([snapshotOnlyId]);
    const written = path.join(claudeHome, 'projects', encodeClaudeProjectKey(path.resolve(projectDir)), 'memory', 'n.md');
    expect(await readFile(written, 'utf8')).toBe('bound project');
    // The snapshot claim was never imported for a project that wasn't materialized.
    expect(recordFor(await readLocalRegistry(stackHome), snapshotOnlyId)).toBeUndefined();
  });

  it('7(c): when the last-known v1 generation was retired by protect, its Protected replica seeds the base (clean push, no false conflict)', async () => {
    const homeA = path.join(root, 'c7-a');
    const git = { kind: 'git' as const, canonical: 'github.com/acme/c7', host: 'github.com', owner: 'acme', repo: 'c7' };
    const item = (contentHash: string, capturedAt: string) => ({
      provider: 'claude' as const,
      kind: 'auto-memory' as const,
      scope: 'project' as const,
      logicalId: 'claude/auto-memory/github.com/acme/c7/a.md',
      project: git,
      contentHash,
      restoreTarget: { base: 'claude-project-memory' as const, relativePath: 'a.md' },
      capturedAt,
      sensitivity: 'private' as const,
    });
    // A Phase-15B-era v1 user: the project already has a registry claim, so
    // the v1 bundle's conversion resolves it to the SAME Project ID.
    await writeLocalRegistry(homeA, resolveOrMintProject(await readLocalRegistry(homeA), git).registry);
    const original = Buffer.from('original note', 'utf8');
    await writeMemoryObject({ stackHome: homeA, contentHash: hashBytes(original), bytes: original });
    await writeMemoryManifest({
      stackHome: homeA,
      manifest: { schemaVersion: 1, provider: 'claude', createdAt: '2026-10-23T00:00:00.000Z', items: [item(hashBytes(original), '2026-10-23T00:00:00.000Z')] },
    });
    const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r3-c7');
    const keys = path.join(root, 'c7-keys');
    expect((await pushStagedMemory(deps(homeA, backend, keys))).status).toBe('standard'); // v1 gen 0, provenance = 0
    // Protect: gen 0 is retired, its replica (gen 1) takes over.
    expect((await runMemoryCloudProtect({ ...deps(homeA, backend, keys), backend }, { recoveryKey: generateRecoveryKey() })).status).toBe('protected');
    expect(await backend.getGeneration(0)).toBeNull();

    // An unpushed local edit, then the first canonical push.
    const edited = Buffer.from('edited, never pushed', 'utf8');
    await writeMemoryObject({ stackHome: homeA, contentHash: hashBytes(edited), bytes: edited });
    await writeMemoryManifest({
      stackHome: homeA,
      manifest: { schemaVersion: 1, provider: 'claude', createdAt: '2026-10-23T00:00:01.000Z', items: [item(hashBytes(edited), '2026-10-23T00:00:01.000Z')] },
    });
    const pushed = await pushMemoryViaCanonical(deps(homeA, backend, keys), {});
    expect(pushed.status).toBe('pushed');
    expect(pushed.generation).toBe(2);
    const docs = (await readCanonicalMain(homeA)).projects[0]?.documents ?? [];
    expect(docs.some((d) => d.state === 'present' && d.contentHash === hashBytes(edited))).toBe(true);
  });
});

describe('materialize never overwrites a native file it did not account for (Task 13 fix round 4)', () => {
  it('an existing native file the scan could not attribute is reported as a conflict, never overwritten', async () => {
    // Located ONLY via the remote snapshot's claim: this machine's local
    // registry has no claim, so the scan can't attribute the native file to
    // the project and plans a write over it — which must be refused.
    const gitRemote = 'https://github.com/acme/unattributed.git';
    const identity = canonicalGitIdentity(gitRemote)!;
    const projectId = mintProjectId();
    const snapshot = toPortableSnapshot(resolveOrMintProject(emptyRegistry(), identity, () => projectId).registry);
    const vendorKey = encodeClaudeProjectKey(path.resolve(projectDir));
    await writeAutoMemory(vendorKey, 'MEMORY.md', 'native edit, never added');
    const stakCopy = Buffer.from('the STAK copy', 'utf8');
    await writeMemoryObject({ stackHome, contentHash: hashBytes(stakCopy), bytes: stakCopy });
    await writeCanonicalMain(stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        {
          projectId,
          documents: [
            { path: 'notes/MEMORY.md', state: 'present', contentHash: hashBytes(stakCopy), importedFrom: 'claude', importedAt: '2026-10-23T00:00:00.000Z' },
          ],
        },
      ],
    });
    const outcome = await materializeCanonicalProjects(stackHome, {
      claudeHome,
      projects: [{ dir: projectDir, gitRemote }],
      remoteRegistrySnapshot: snapshot,
    });
    const native = path.join(claudeHome, 'projects', vendorKey, 'memory', 'MEMORY.md');
    expect(await readFile(native, 'utf8')).toBe('native edit, never added');
    expect(outcome.conflicts).toContainEqual({ projectId, path: 'notes/MEMORY.md', reason: 'adopt-mismatch' });
  });
});

describe('Task 13 fix round 5', () => {
  const secureKeys = (dir: string) =>
    fileLocalMemoryKeyStore(dir, {
      harden: () => Promise.resolve(true),
      verify: () => Promise.resolve(true),
    });
  const fakeBackup = (): Promise<BackupResult> =>
    Promise.resolve({ provider: 'claude', files: 0, projects: 0, createdAt: '2026-10-23T00:00:00.000Z' });
  const deps = (home: string, backend: RemoteMemoryBackend | null, keysDir: string) => ({
    stackHome: home,
    backend,
    localKeyStore: secureKeys(keysDir),
    runLocalBackup: fakeBackup,
  });
  const bindAt = async (home: string, dir: string, fixedProjectId?: string) => {
    let registry = await readLocalRegistry(home);
    const minted = resolveOrMintProject(
      registry,
      { kind: 'local', vendorKey: `v-${path.basename(home)}-${path.basename(dir)}` },
      fixedProjectId ? () => fixedProjectId : mintProjectId,
    );
    registry = setBinding(minted.registry, { projectId: minted.projectId, dir, boundAt: '2026-10-23T00:00:00.000Z', provenance: 'user-map' });
    await writeLocalRegistry(home, registry);
    return minted.projectId;
  };
  const memoryFileOf = (claudeHomeDir: string, dir: string) =>
    path.join(claudeHomeDir, 'projects', encodeClaudeProjectKey(path.resolve(dir)), 'memory', 'MEMORY.md');
  const writeMemoryFile = async (file: string, body: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, 'utf8');
  };

  it('a remote edit to an existing file reaches the other machine (X v1 -> Y pull -> X v2 -> Y pull): Y gets v2, no conflict', async () => {
    const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r5-two-machine-update');
    const homeX = path.join(root, 'x-stack');
    const claudeX = path.join(root, 'x-claude');
    const dirX = path.join(root, 'x-proj');
    const homeY = path.join(root, 'y-stack');
    const claudeY = path.join(root, 'y-claude');
    const dirY = path.join(root, 'y-proj');
    await mkdir(dirX, { recursive: true });
    await mkdir(dirY, { recursive: true });
    const projectId = await bindAt(homeX, dirX);
    await bindAt(homeY, dirY, projectId);

    await writeMemoryFile(memoryFileOf(claudeX, dirX), 'v1');
    await stageCanonicalMemory(homeX, { claudeHome: claudeX });
    expect((await pushMemoryViaCanonical(deps(homeX, backend, path.join(root, 'x-keys')), { claudeHome: claudeX })).status).toBe('pushed');
    await pullMemoryViaCanonical(deps(homeY, backend, path.join(root, 'y-keys')), { claudeHome: claudeY });
    expect(await readFile(memoryFileOf(claudeY, dirY), 'utf8')).toBe('v1');

    await writeMemoryFile(memoryFileOf(claudeX, dirX), 'v2');
    await stageCanonicalMemory(homeX, { claudeHome: claudeX });
    expect((await pushMemoryViaCanonical(deps(homeX, backend, path.join(root, 'x-keys')), { claudeHome: claudeX })).status).toBe('pushed');
    const pulled = await pullMemoryViaCanonical(deps(homeY, backend, path.join(root, 'y-keys')), { claudeHome: claudeY });
    expect(pulled.conflicts ?? []).toEqual([]);
    expect(await readFile(memoryFileOf(claudeY, dirY), 'utf8')).toBe('v2');
  });

  it('after the latest generation is retired, the next push still succeeds (expectedParent comes from the commit counter)', async () => {
    const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r5-retired-latest');
    await bindProject(projectDir);
    const keys = path.join(root, 'keys');
    await writeAutoMemory(encodeClaudeProjectKey(path.resolve(projectDir)), 'MEMORY.md', 'one');
    await stageCanonicalMemory(stackHome, { claudeHome });
    expect((await pushMemoryViaCanonical(deps(stackHome, backend, keys), { claudeHome })).status).toBe('pushed');
    await writeAutoMemory(encodeClaudeProjectKey(path.resolve(projectDir)), 'MEMORY.md', 'two');
    await stageCanonicalMemory(stackHome, { claudeHome });
    expect((await pushMemoryViaCanonical(deps(stackHome, backend, keys), { claudeHome })).status).toBe('pushed');
    // The highest generation is retired (e.g. protect's escape crash window).
    const latest = (await backend.getLatest())!;
    await backend.retireGeneration(latest.backupId);
    expect((await backend.getProfile())?.latestGeneration).toBe(latest.generation);

    await writeAutoMemory(encodeClaudeProjectKey(path.resolve(projectDir)), 'MEMORY.md', 'three');
    await stageCanonicalMemory(stackHome, { claudeHome });
    const pushed = await pushMemoryViaCanonical(deps(stackHome, backend, keys), { claudeHome });
    expect(pushed.status).toBe('pushed');
    expect(pushed.generation).toBe(latest.generation + 1);
  });

  it('after every generation is retired (Delete Cloud Memory), a pull changes nothing locally and the next push re-uploads local content (fix round 6)', async () => {
    const store = new InMemoryRemoteMemoryStore();
    const backend = inMemoryRemoteMemoryBackend(store, 'r6-emptied');
    const homeX = path.join(root, 'x6-stack');
    const claudeX = path.join(root, 'x6-claude');
    const dirX = path.join(root, 'x6-proj');
    const homeY = path.join(root, 'y6-stack');
    const claudeY = path.join(root, 'y6-claude');
    const dirY = path.join(root, 'y6-proj');
    await mkdir(dirX, { recursive: true });
    await mkdir(dirY, { recursive: true });
    const projectId = await bindAt(homeX, dirX);
    await bindAt(homeY, dirY, projectId);
    const keysX = path.join(root, 'x6-keys');
    const keysY = path.join(root, 'y6-keys');

    await writeMemoryFile(memoryFileOf(claudeX, dirX), 'v1');
    await stageCanonicalMemory(homeX, { claudeHome: claudeX });
    expect((await pushMemoryViaCanonical(deps(homeX, backend, keysX), { claudeHome: claudeX })).status).toBe('pushed');
    await pullMemoryViaCanonical(deps(homeY, backend, keysY), { claudeHome: claudeY });
    await writeMemoryFile(memoryFileOf(claudeX, dirX), 'v2');
    await stageCanonicalMemory(homeX, { claudeHome: claudeX });
    expect((await pushMemoryViaCanonical(deps(homeX, backend, keysX), { claudeHome: claudeX })).status).toBe('pushed');
    // Y's base is now BEHIND the counter (it last synced v1).

    // Delete Cloud Memory: every generation retired, the counter is not reset.
    for (const backupId of await backend.listAllBackupIds()) await backend.retireGeneration(backupId);
    expect(await backend.getLatest()).toBeNull();
    expect((await backend.getProfile())?.latestGeneration).toBe(1);

    const yMainBefore = await readFile(path.join(homeY, 'memory', 'canonical', 'main.json'), 'utf8');
    const pulled = await pullMemoryViaCanonical(deps(homeY, backend, keysY), { claudeHome: claudeY });
    expect(pulled.status).toBe('up-to-date');
    expect(await readFile(memoryFileOf(claudeY, dirY), 'utf8')).toBe('v1'); // native untouched
    expect(await readFile(path.join(homeY, 'memory', 'canonical', 'main.json'), 'utf8')).toBe(yMainBefore);

    // Y pushes: a fast-forward re-upload of its own content at counter + 1.
    const pushed = await pushMemoryViaCanonical(deps(homeY, backend, keysY), { claudeHome: claudeY });
    expect(pushed).toMatchObject({ status: 'pushed', generation: 2 });
    const cloud = await fetchRemoteCanonical({ backend, localRegistry: await readLocalRegistry(homeY) });
    expect(cloud?.main).toEqual(await readCanonicalMain(homeY));
    expect(cloud?.main.projects[0]?.documents.every((d) => d.state === 'present')).toBe(true);
  });

  it('stale base after Delete Cloud Memory: when another machine re-uploads older content, X keeps its edit and its X-only doc (no native overwrite or delete) (fix round 7)', async () => {
    const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r7-stale-base');
    const homeX = path.join(root, 'x7-stack');
    const claudeX = path.join(root, 'x7-claude');
    const dirX = path.join(root, 'x7-proj');
    const homeY = path.join(root, 'y7-stack');
    const claudeY = path.join(root, 'y7-claude');
    const dirY = path.join(root, 'y7-proj');
    await mkdir(dirX, { recursive: true });
    await mkdir(dirY, { recursive: true });
    const projectId = await bindAt(homeX, dirX);
    await bindAt(homeY, dirY, projectId);
    const keysX = path.join(root, 'x7-keys');
    const keysY = path.join(root, 'y7-keys');
    const xOnly = path.join(path.dirname(memoryFileOf(claudeX, dirX)), 'x-only.md');

    // 1. X pushes v1, Y pulls, X pushes v2 plus a doc only X has.
    await writeMemoryFile(memoryFileOf(claudeX, dirX), 'v1');
    await stageCanonicalMemory(homeX, { claudeHome: claudeX });
    expect((await pushMemoryViaCanonical(deps(homeX, backend, keysX), { claudeHome: claudeX })).status).toBe('pushed');
    await pullMemoryViaCanonical(deps(homeY, backend, keysY), { claudeHome: claudeY });
    await writeMemoryFile(memoryFileOf(claudeX, dirX), 'v2');
    await writeMemoryFile(xOnly, 'only on X');
    await stageCanonicalMemory(homeX, { claudeHome: claudeX });
    expect((await pushMemoryViaCanonical(deps(homeX, backend, keysX), { claudeHome: claudeX })).status).toBe('pushed');

    // 2. Everything is retired; Y re-uploads its stale v1 as generation 2.
    for (const backupId of await backend.listAllBackupIds()) await backend.retireGeneration(backupId);
    expect(await pushMemoryViaCanonical(deps(homeY, backend, keysY), { claudeHome: claudeY })).toMatchObject({
      status: 'pushed',
      generation: 2,
    });

    // 3. X pulls. Its recorded base (gen 1) is gone from Cloud, so it merges
    // against an empty base: MEMORY.md is a conflict, x-only.md is kept.
    const xMainBefore = await readFile(path.join(homeX, 'memory', 'canonical', 'main.json'), 'utf8');
    const pulled = await pullMemoryViaCanonical(deps(homeX, backend, keysX), { claudeHome: claudeX });
    expect(pulled.status).toBe('conflict');
    expect(pulled.conflicts?.map((c) => c.path)).toEqual(['notes/MEMORY.md']);
    expect(await readFile(memoryFileOf(claudeX, dirX), 'utf8')).toBe('v2');
    expect(await readFile(xOnly, 'utf8')).toBe('only on X');
    expect(await readFile(path.join(homeX, 'memory', 'canonical', 'main.json'), 'utf8')).toBe(xMainBefore);
    // X's push is blocked by the same conflict — Cloud is never overwritten blindly either.
    // (Task 14 fix round 1: Cloud has not moved and the merge is still current,
    // so push stops with spec A.6 `merge-pending` before changing anything.)
    await expect(pushMemoryViaCanonical(deps(homeX, backend, keysX), { claudeHome: claudeX })).rejects.toMatchObject({
      code: 'merge-pending',
    });
    expect((await backend.getLatest())?.generation).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Task 14: `stak memory resolve` / `diff` / `materialize`                     */
/* -------------------------------------------------------------------------- */

describe('Task 14: resolve / diff / materialize', () => {
  const secureKeys = (dir: string) =>
    fileLocalMemoryKeyStore(dir, {
      harden: () => Promise.resolve(true),
      verify: () => Promise.resolve(true),
    });
  const fakeBackup = (): Promise<BackupResult> =>
    Promise.resolve({ provider: 'claude', files: 0, projects: 0, createdAt: '2026-10-23T00:00:00.000Z' });

  type Machine = { home: string; claude: string; dir: string; keys: string };
  const machine = async (tag: string): Promise<Machine> => {
    const m = {
      home: path.join(root, `${tag}-stack`),
      claude: path.join(root, `${tag}-claude`),
      dir: path.join(root, `${tag}-proj`),
      keys: path.join(root, `${tag}-keys`),
    };
    await mkdir(m.dir, { recursive: true });
    return m;
  };
  const depsOf = (m: Machine, backend: RemoteMemoryBackend | null, keys = m.keys) => ({
    stackHome: m.home,
    backend,
    localKeyStore: secureKeys(keys),
    runLocalBackup: fakeBackup,
  });
  const discoveryOf = (m: Machine) => ({ claudeHome: m.claude });
  const bindAt = async (m: Machine, fixedProjectId?: string) => {
    let registry = await readLocalRegistry(m.home);
    const minted = resolveOrMintProject(
      registry,
      { kind: 'local', vendorKey: `v-${path.basename(m.home)}` },
      fixedProjectId ? () => fixedProjectId : mintProjectId,
    );
    registry = setBinding(minted.registry, { projectId: minted.projectId, dir: m.dir, boundAt: '2026-10-23T00:00:00.000Z', provenance: 'user-map' });
    await writeLocalRegistry(m.home, registry);
    return minted.projectId;
  };
  const nativeOf = (m: Machine, name = 'MEMORY.md') =>
    path.join(m.claude, 'projects', encodeClaudeProjectKey(path.resolve(m.dir)), 'memory', name);
  const writeNative = async (m: Machine, body: string, name = 'MEMORY.md') => {
    await mkdir(path.dirname(nativeOf(m, name)), { recursive: true });
    await writeFile(nativeOf(m, name), body, 'utf8');
  };
  const removeNative = async (m: Machine, name = 'MEMORY.md') => rm(nativeOf(m, name), { force: true });
  const stage = (m: Machine) => stageCanonicalMemory(m.home, discoveryOf(m));
  const push = (m: Machine, backend: RemoteMemoryBackend | null, keys?: string) =>
    pushMemoryViaCanonical(depsOf(m, backend, keys), discoveryOf(m));
  const pull = (m: Machine, backend: RemoteMemoryBackend | null) => pullMemoryViaCanonical(depsOf(m, backend), discoveryOf(m));
  /** Drop `notes/MEMORY.md` from a machine's canonical main entirely ("absent", not a tombstone). */
  const dropFromMain = async (m: Machine) => {
    const main = await readCanonicalMain(m.home);
    await writeCanonicalMain(m.home, {
      ...main,
      projects: main.projects.map((p) => ({ ...p, documents: p.documents.filter((d) => d.path !== 'notes/MEMORY.md') })),
    });
  };
  const canonicalFile = (m: Machine, name: string) => path.join(m.home, 'memory', 'canonical', name);
  const mergePath = (m: Machine) => canonicalFile(m, 'merge.json');
  const docAt = async (m: Machine, projectId: string, docPath = 'notes/MEMORY.md') =>
    (await readCanonicalMain(m.home)).projects.find((p) => p.projectId === projectId)?.documents.find((d) => d.path === docPath);
  const hashOf = (body: string) => hashBytes(Buffer.from(body, 'utf8'));
  const present = (body: string) => ({ state: 'present', contentHash: hashOf(body) });
  const deleted = (body: string) => ({ state: 'deleted', lastContentHash: hashOf(body) });

  /** X (the "Cloud" side) and Y (the "local" side) share one project. Both
   * start synced at `notes/MEMORY.md` = "a" (generation 0). `notes/keep.md`
   * is there so deleting MEMORY.md is a real deletion, not an emptied memory
   * folder (which the mass-delete guard treats as "not materialized"). */
  const synced = async (tag: string) => {
    const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), `t14-${tag}`);
    const X = await machine(`${tag}-x`);
    const Y = await machine(`${tag}-y`);
    const projectId = await bindAt(X);
    await bindAt(Y, projectId);
    await writeNative(X, 'kept', 'keep.md');
    await writeNative(X, 'a');
    await stage(X);
    expect((await push(X, backend)).status).toBe('pushed');
    await pull(Y, backend);
    expect(await readFile(nativeOf(Y), 'utf8')).toBe('a');
    return { backend, X, Y, projectId };
  };

  type SideChange = 'edit' | 'delete' | 'edit-then-delete' | 'absent';
  const change = async (m: Machine, kind: SideChange, body: string) => {
    if (kind === 'edit') {
      await writeNative(m, body);
      await stage(m);
    } else if (kind === 'delete') {
      await removeNative(m);
      await stage(m);
    } else if (kind === 'edit-then-delete') {
      await writeNative(m, body);
      await stage(m);
      await removeNative(m);
      await stage(m);
    } else {
      await dropFromMain(m);
    }
  };

  /** The Cloud side (X) changes and pushes generation 1; the local side (Y) changes and its push conflicts. */
  const conflicted = async (tag: string, cloud: SideChange, local: SideChange) => {
    const s = await synced(tag);
    await change(s.X, cloud, 'c');
    expect((await push(s.X, s.backend)).status).toBe('pushed');
    await change(s.Y, local, 'b');
    const pushedY = await push(s.Y, s.backend);
    expect(pushedY.status).toBe('conflict');
    return s;
  };

  type Expected = { state: string; contentHash?: string; lastContentHash?: string };
  const cases: {
    name: string;
    cloud: SideChange;
    local: SideChange;
    reason: string;
    expected: Record<'local' | 'cloud' | 'both', Expected>;
    bothAlt?: { state: string; contentHash: string };
  }[] = [
    {
      name: 'edit-edit',
      cloud: 'edit',
      local: 'edit',
      reason: 'edit-edit',
      expected: { local: present('b'), cloud: present('c'), both: present('c') },
      bothAlt: present('b'),
    },
    {
      name: 'edit-delete, local edited, Cloud tombstone',
      cloud: 'delete',
      local: 'edit',
      reason: 'edit-delete',
      // keep both (fix round 1): Cloud's tombstone keeps the original path; local's copy moves aside.
      expected: { local: present('b'), cloud: deleted('a'), both: deleted('a') },
      bothAlt: present('b'),
    },
    {
      name: 'edit-delete, local tombstone, Cloud edited',
      cloud: 'edit',
      local: 'delete',
      reason: 'edit-delete',
      expected: { local: deleted('a'), cloud: present('c'), both: present('c') },
    },
    {
      name: 'edit-delete, local edited, Cloud absent',
      cloud: 'absent',
      local: 'edit',
      reason: 'edit-delete',
      // keep cloud = the deletion: a tombstone of the content it deletes (local's).
      // keep both (fix round 1): the deletion keeps the original path; local's copy moves aside.
      expected: { local: present('b'), cloud: deleted('b'), both: deleted('b') },
      bothAlt: present('b'),
    },
    {
      name: 'edit-delete, local absent, Cloud edited',
      cloud: 'edit',
      local: 'absent',
      reason: 'edit-delete',
      // keep local = the deletion: a tombstone carrying Cloud's hash, so it propagates.
      expected: { local: deleted('c'), cloud: present('c'), both: present('c') },
    },
    {
      name: 'delete-delete, differing tombstones',
      cloud: 'edit-then-delete',
      local: 'edit-then-delete',
      reason: 'delete-delete',
      expected: { local: deleted('b'), cloud: deleted('c'), both: deleted('c') },
    },
    {
      name: 'delete-delete, local absent, Cloud tombstone',
      cloud: 'delete',
      local: 'absent',
      reason: 'delete-delete',
      expected: { local: deleted('a'), cloud: deleted('a'), both: deleted('a') },
    },
    {
      name: 'delete-delete, local tombstone, Cloud absent',
      cloud: 'absent',
      local: 'delete',
      reason: 'delete-delete',
      expected: { local: deleted('a'), cloud: deleted('a'), both: deleted('a') },
    },
  ];
  const bodyOf = (hash: string | undefined) =>
    ['a', 'b', 'c'].find((body) => hashOf(body) === hash);

  let caseIndex = 0;
  for (const c of cases)
    for (const keep of ['local', 'cloud', 'both'] as const) {
      caseIndex += 1;
      const tag = `m${caseIndex}`;
      it(`${c.name}: keep ${keep}`, async () => {
        const { backend, X, Y, projectId } = await conflicted(tag, c.cloud, c.local);
        expect(await listPendingConflicts(Y.home)).toEqual([
          expect.objectContaining({ projectId, path: 'notes/MEMORY.md', reason: c.reason }),
        ]);
        const generationsBefore = (await backend.listGenerations()).length;

        const outcome = await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', keep);
        expect(outcome.remaining).toBe(0);

        // Main holds the chosen document state; merge.json is gone; base is r with Cloud's content at r.
        expect(await docAt(Y, projectId)).toMatchObject(c.expected[keep]);
        expect(await exists(mergePath(Y))).toBe(false);
        const base = await readCanonicalBase(Y.home);
        expect(base?.generation).toBe(1);
        expect(base?.main).toEqual(
          (await fetchRemoteCanonical({ backend, localRegistry: await readLocalRegistry(Y.home), generation: 1 }))?.main,
        );

        if (keep === 'both' && c.bothAlt) {
          const hex = c.bothAlt.contentHash.slice('sha256:'.length);
          expect(outcome.altPath).toBe(`notes/MEMORY.conflict-${hex.slice(0, 12)}.md`);
          expect(await docAt(Y, projectId, outcome.altPath)).toMatchObject(c.bothAlt);
          // Materialized: the original path holds Cloud's state, the alt path local's content.
          const primary = c.expected.both;
          if (primary.state === 'present') expect(await readFile(nativeOf(Y), 'utf8')).toBe(bodyOf(primary.contentHash));
          else expect(await exists(nativeOf(Y))).toBe(false);
          expect(await readFile(nativeOf(Y, path.posix.basename(outcome.altPath ?? '')), 'utf8')).toBe('b');
        } else {
          expect(outcome.altPath).toBeUndefined();
          const docs = (await readCanonicalMain(Y.home)).projects.find((p) => p.projectId === projectId)?.documents ?? [];
          expect(docs.some((d) => d.path.includes('.conflict-'))).toBe(false);
          // The native file reflects the resolved state.
          const expected = c.expected[keep];
          if (expected.state === 'present') expect(await readFile(nativeOf(Y), 'utf8')).toBe(bodyOf(expected.contentHash));
          else expect(await exists(nativeOf(Y))).toBe(false);
        }

        // The next push goes against r: no conflict, at most one generation, Cloud = local.
        const pushed = await push(Y, backend);
        expect(['pushed', 'up-to-date']).toContain(pushed.status);
        const localMain = await readCanonicalMain(Y.home);
        const cloudNow = await fetchRemoteCanonical({ backend, localRegistry: await readLocalRegistry(Y.home) });
        expect(cloudNow && canonicalDigest(cloudNow.main)).toBe(canonicalDigest(localMain));
        expect((await backend.listGenerations()).length - generationsBefore).toBe(pushed.status === 'pushed' ? 1 : 0);
        // And the other machine pulls the resolution with no conflict.
        expect((await pull(X, backend)).status).not.toBe('conflict');
      });
    }

  it('C2: resolve keep local, then push: exactly one generation, no conflict reappears, Cloud holds the resolution', async () => {
    const { backend, Y, projectId } = await conflicted('c2ff', 'edit', 'edit');
    const before = (await backend.listGenerations()).length;
    await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'local');
    const pushed = await push(Y, backend);
    expect(pushed.status).toBe('pushed');
    expect(pushed.conflicts ?? []).toEqual([]);
    expect((await backend.listGenerations()).length).toBe(before + 1);
    const cloud = await fetchRemoteCanonical({ backend, localRegistry: await readLocalRegistry(Y.home) });
    expect(cloud?.main.projects[0]?.documents.find((d) => d.path === 'notes/MEMORY.md')).toMatchObject(present('b'));
    // A second push is a no-op.
    expect((await push(Y, backend)).status).toBe('up-to-date');
    expect((await backend.listGenerations()).length).toBe(before + 1);
  });

  it("C2: Cloud moves to r' after the resolution (a different file): the push re-merges against base r cleanly, one generation", async () => {
    const { backend, X, Y, projectId } = await conflicted('c2moved', 'edit', 'edit');
    await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'local');
    await writeNative(X, 'x other', 'other.md');
    await stage(X);
    expect((await push(X, backend)).status).toBe('pushed');
    const before = (await backend.listGenerations()).length;
    const pushed = await push(Y, backend);
    expect(pushed.status).toBe('pushed');
    expect((await backend.listGenerations()).length).toBe(before + 1);
    expect(await docAt(Y, projectId)).toMatchObject(present('b'));
    expect(await docAt(Y, projectId, 'notes/other.md')).toMatchObject(present('x other'));
  });

  it('C2 / spec 8.3: Cloud changes the SAME document again after the resolution: a fresh conflict, never a blind replay', async () => {
    const { backend, X, Y, projectId } = await conflicted('c2again', 'edit', 'edit');
    await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'local');
    await writeNative(X, 'd');
    await stage(X);
    expect((await push(X, backend)).status).toBe('pushed');
    const before = (await backend.listGenerations()).length;
    const pushed = await push(Y, backend);
    expect(pushed.status).toBe('conflict');
    expect(pushed.conflicts?.map((c) => c.path)).toEqual(['notes/MEMORY.md']);
    expect((await backend.listGenerations()).length).toBe(before);
  });

  it('C2: with two conflicts, resolving one only updates merge.json (main and base untouched); resolving the last finalizes', async () => {
    const s = await synced('c2partial');
    await writeNative(s.X, 'a2', 'two.md');
    await stage(s.X);
    expect((await push(s.X, s.backend)).status).toBe('pushed');
    await pull(s.Y, s.backend);
    await writeNative(s.X, 'c');
    await writeNative(s.X, 'c2', 'two.md');
    await stage(s.X);
    expect((await push(s.X, s.backend)).status).toBe('pushed');
    await writeNative(s.Y, 'b');
    await writeNative(s.Y, 'b2', 'two.md');
    await stage(s.Y);
    expect((await push(s.Y, s.backend)).status).toBe('conflict');
    expect((await listPendingConflicts(s.Y.home)).map((c) => c.path)).toEqual(['notes/MEMORY.md', 'notes/two.md']);

    const mainBefore = await readFile(canonicalFile(s.Y, 'main.json'), 'utf8');
    const baseBefore = await readFile(canonicalFile(s.Y, 'base.json'), 'utf8');
    const first = await resolvePendingConflict(depsOf(s.Y, s.backend), discoveryOf(s.Y), s.projectId, 'notes/MEMORY.md', 'cloud');
    expect(first.remaining).toBe(1);
    expect(await readFile(canonicalFile(s.Y, 'main.json'), 'utf8')).toBe(mainBefore);
    expect(await readFile(canonicalFile(s.Y, 'base.json'), 'utf8')).toBe(baseBefore);
    expect(await readFile(nativeOf(s.Y), 'utf8')).toBe('b'); // nothing materialized yet
    expect((await listPendingConflicts(s.Y.home)).map((c) => c.path)).toEqual(['notes/two.md']);

    const last = await resolvePendingConflict(depsOf(s.Y, s.backend), discoveryOf(s.Y), s.projectId, 'notes/two.md', 'local');
    expect(last.remaining).toBe(0);
    expect(await docAt(s.Y, s.projectId)).toMatchObject(present('c'));
    expect(await docAt(s.Y, s.projectId, 'notes/two.md')).toMatchObject(present('b2'));
    expect(await readFile(nativeOf(s.Y), 'utf8')).toBe('c');
    expect(await exists(mergePath(s.Y))).toBe(false);
    const pushed = await push(s.Y, s.backend);
    expect(pushed.status).toBe('pushed');
  });

  it('accepts a unique Project ID prefix (like `stak project`) and rejects an unknown conflict path', async () => {
    const { backend, Y, projectId } = await conflicted('prefix', 'edit', 'edit');
    await expect(
      resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/nope.md', 'local'),
    ).rejects.toThrow(/No pending Memory conflict/);
    const outcome = await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId.slice(0, 10), 'notes/MEMORY.md', 'local');
    expect(outcome.projectId).toBe(projectId);
  });

  it('no pending merge: resolve and diff say so, listing is empty', async () => {
    const { backend, Y, projectId } = await synced('none');
    expect(await listPendingConflicts(Y.home)).toEqual([]);
    await expect(
      resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'local'),
    ).rejects.toThrow(/No pending Memory conflicts/);
    await expect(diffPendingConflict(depsOf(Y, backend), projectId, 'notes/MEMORY.md')).rejects.toThrow(/No pending Memory conflicts/);
  });

  describe('fix round 1', () => {
    /** Two conflicts on Y: MEMORY.md (b vs c) and two.md (b2 vs c2), against generation 2. */
    const twoConflicts = async (tag: string) => {
      const s = await synced(tag);
      await writeNative(s.X, 'a2', 'two.md');
      await stage(s.X);
      expect((await push(s.X, s.backend)).status).toBe('pushed');
      await pull(s.Y, s.backend);
      await writeNative(s.X, 'c');
      await writeNative(s.X, 'c2', 'two.md');
      await stage(s.X);
      expect((await push(s.X, s.backend)).status).toBe('pushed');
      await writeNative(s.Y, 'b');
      await writeNative(s.Y, 'b2', 'two.md');
      await stage(s.Y);
      expect((await push(s.Y, s.backend)).status).toBe('conflict');
      return s;
    };

    it('Critical 1: an edit staged after a partial resolution makes the merge stale; it is never reverted to the recorded choice', async () => {
      const { backend, Y, projectId } = await twoConflicts('r1crit');
      await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/two.md', 'local'); // records b2
      await writeNative(Y, 'b3', 'two.md');
      await stage(Y);
      const mainBefore = await readFile(canonicalFile(Y, 'main.json'), 'utf8');
      await expect(
        resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'cloud'),
      ).rejects.toThrow(/changed since this merge was prepared/);
      expect(await readFile(canonicalFile(Y, 'main.json'), 'utf8')).toBe(mainBefore);
      expect(await docAt(Y, projectId, 'notes/two.md')).toMatchObject(present('b3'));
      expect(await readFile(nativeOf(Y, 'two.md'), 'utf8')).toBe('b3');
      // The stale merge no longer blocks push: it re-merges (both paths conflict again).
      const pushed = await push(Y, backend);
      expect(pushed.status).toBe('conflict');
      expect((await listPendingConflicts(Y.home)).map((c) => c.path)).toEqual(['notes/MEMORY.md', 'notes/two.md']);
      await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/two.md', 'local');
      await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'cloud');
      expect(await docAt(Y, projectId, 'notes/two.md')).toMatchObject(present('b3'));
      expect(await readFile(nativeOf(Y, 'two.md'), 'utf8')).toBe('b3');
    });

    it('Important 3: after a partial resolve, push / pull / backup stop with merge-pending, change nothing, and keep the resolution', async () => {
      const { backend, Y, projectId } = await twoConflicts('r1pending');
      await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'cloud');
      const snapshot = async () => ({
        main: await readFile(canonicalFile(Y, 'main.json'), 'utf8'),
        base: await readFile(canonicalFile(Y, 'base.json'), 'utf8'),
        merge: await readFile(mergePath(Y), 'utf8'),
        generations: (await backend.listGenerations()).length,
      });
      const before = await snapshot();

      const pushError = await push(Y, backend).catch((error: unknown) => error);
      expect(pushError).toBeInstanceOf(MemorySyncError);
      expect((pushError as MemorySyncError).code).toBe('merge-pending');
      expect((pushError as MemorySyncError).message).toContain('Resolve the listed conflicts, then push again');
      expect((pushError as MemorySyncError).conflicts.map((c) => c.path)).toEqual(['notes/two.md']);

      await expect(pull(Y, backend)).rejects.toThrow(/Resolve the listed conflicts, then push again/);
      const backup = await runMemoryCloudBackup(depsOf(Y, backend), { migrate: async () => undefined });
      expect(backup.cloud).toMatchObject({ status: 'conflict' });

      expect(await snapshot()).toEqual(before);
      expect(JSON.parse(before.merge).resolved).toEqual([
        expect.objectContaining({ projectId, path: 'notes/MEMORY.md', keep: 'cloud', local: expect.objectContaining(present('b')) }),
      ]);
      // Finishing the remaining conflict still works, then push publishes once.
      await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/two.md', 'local');
      expect((await push(Y, backend)).status).toBe('pushed');
      expect((await backend.listGenerations()).length).toBe(before.generations + 1);
    });

    it('Important 3: with Cloud moved since the merge, push re-merges instead of stopping', async () => {
      const { backend, X, Y, projectId } = await twoConflicts('r1moved');
      await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'cloud');
      await writeNative(X, 'x other', 'other.md');
      await stage(X);
      expect((await push(X, backend)).status).toBe('pushed');
      const pushed = await push(Y, backend);
      expect(pushed.status).toBe('conflict'); // re-merged against the new generation: old choices are not replayed
      expect((await listPendingConflicts(Y.home)).map((c) => c.path)).toEqual(['notes/MEMORY.md', 'notes/two.md']);
      expect(JSON.parse(await readFile(mergePath(Y), 'utf8')).resolved).toBeUndefined();
    });

    it('Important 3: with no merge pending, push and pull behave as before', async () => {
      const { backend, X, Y } = await synced('r1none');
      await writeNative(X, 'next');
      await stage(X);
      expect((await push(X, backend)).status).toBe('pushed');
      expect((await pull(Y, backend)).status).toBe('merged');
      expect(await readFile(nativeOf(Y), 'utf8')).toBe('next');
      expect(await exists(mergePath(Y))).toBe(false);
    });

    it('Minor: a phantom merge.json left by a crash after the final resolve wrote main and base is cleared by the next push', async () => {
      const { backend, Y, projectId } = await conflicted('r1phantom', 'edit', 'edit');
      const leftover = await readFile(mergePath(Y), 'utf8');
      await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'local');
      await writeFile(mergePath(Y), leftover, 'utf8'); // the crash: main + base written, merge not cleared
      const before = (await backend.listGenerations()).length;
      const pushed = await push(Y, backend);
      expect(pushed.status).toBe('pushed');
      expect((await backend.listGenerations()).length).toBe(before + 1);
      expect(await exists(mergePath(Y))).toBe(false);
      expect(await listPendingConflicts(Y.home)).toEqual([]);
    });

    it("Minor: a merge made while Cloud's highest generation is retired records the content generation, so it can be resolved", async () => {
      const s = await synced('r1counter');
      await writeNative(s.X, 'c');
      await stage(s.X);
      expect((await push(s.X, s.backend)).status).toBe('pushed'); // gen 1
      await writeNative(s.X, 'extra', 'extra.md');
      await stage(s.X);
      expect((await push(s.X, s.backend)).status).toBe('pushed'); // gen 2
      const latest = await s.backend.getLatest();
      if (!latest) throw new Error('test setup: expected a latest generation');
      await s.backend.retireGeneration(latest.backupId);
      expect((await s.backend.getProfile())?.latestGeneration).toBe(2);
      await writeNative(s.Y, 'b');
      await stage(s.Y);
      expect((await push(s.Y, s.backend)).status).toBe('conflict');
      expect(JSON.parse(await readFile(mergePath(s.Y), 'utf8')).basedOnGeneration).toBe(1);
      const diff = await diffPendingConflict(depsOf(s.Y, s.backend), s.projectId, 'notes/MEMORY.md');
      expect(diff.cloud).toEqual({ state: 'present', text: 'c' });
      await resolvePendingConflict(depsOf(s.Y, s.backend), discoveryOf(s.Y), s.projectId, 'notes/MEMORY.md', 'local');
      const pushed = await push(s.Y, s.backend);
      expect(pushed).toMatchObject({ status: 'pushed', generation: 3 });
      expect(await docAt(s.Y, s.projectId)).toMatchObject(present('b'));
    });
  });

  describe('C4: fail closed on the Cloud side (nothing changes)', () => {
    const snapshot = async (m: Machine) => ({
      main: await readFile(canonicalFile(m, 'main.json'), 'utf8'),
      base: await readFile(canonicalFile(m, 'base.json'), 'utf8'),
      merge: await readFile(mergePath(m), 'utf8'),
      native: await readFile(nativeOf(m), 'utf8'),
    });

    it('not signed in', async () => {
      const { Y, projectId } = await conflicted('c4out', 'delete', 'edit');
      const before = await snapshot(Y);
      await expect(
        resolvePendingConflict(depsOf(Y, null), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'cloud'),
      ).rejects.toThrow(/Not signed in/);
      await expect(diffPendingConflict(depsOf(Y, null), projectId, 'notes/MEMORY.md')).rejects.toThrow(/Not signed in/);
      expect(await snapshot(Y)).toEqual(before);
    });

    it('Protected and locked on this device', async () => {
      const { backend, Y, projectId } = await conflicted('c4locked', 'delete', 'edit');
      await backend.setPrivacyMode('protected');
      const before = await snapshot(Y);
      await expect(
        resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'cloud'),
      ).rejects.toThrow(/locked/);
      expect(await snapshot(Y)).toEqual(before);
    });

    it('generation r retired with no replica (Delete Cloud Memory)', async () => {
      const { backend, Y, projectId } = await conflicted('c4retired', 'delete', 'edit');
      for (const backupId of await backend.listAllBackupIds()) await backend.retireGeneration(backupId);
      const before = await snapshot(Y);
      await expect(
        resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'cloud'),
      ).rejects.toThrow(/no longer has/);
      await expect(diffPendingConflict(depsOf(Y, backend), projectId, 'notes/MEMORY.md')).rejects.toThrow(/no longer has/);
      expect(await snapshot(Y)).toEqual(before);
    });

    it('C5: resolve and diff read exactly generation r, never latest', async () => {
      const { backend, X, Y, projectId } = await conflicted('c5exact', 'edit', 'edit');
      await writeNative(X, 'newer');
      await stage(X);
      expect((await push(X, backend)).status).toBe('pushed');
      const diff = await diffPendingConflict(depsOf(Y, backend), projectId, 'notes/MEMORY.md');
      expect(diff.cloud).toEqual({ state: 'present', text: 'c' });
      await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'cloud');
      expect(await docAt(Y, projectId)).toMatchObject(present('c'));
      // The resolution belongs to r; Cloud's newer change is one-sided since r and merges in cleanly.
      const pushed = await push(Y, backend);
      expect(pushed.status).toBe('up-to-date');
      expect(await docAt(Y, projectId)).toMatchObject(present('newer'));
    });

    it('generation r retired by `stak memory protect`: its committed Protected replica is read', async () => {
      const { backend, X, Y, projectId } = await conflicted('c4replica', 'edit', 'edit');
      expect(
        (await runMemoryCloudProtect({ ...depsOf(X, backend), backend }, { recoveryKey: generateRecoveryKey() })).status,
      ).toBe('protected');
      expect(await backend.getGeneration(1)).toBeNull();
      // Y uses a device key store that can unlock the account (the same one as X).
      const outcome = await resolvePendingConflict(depsOf(Y, backend, X.keys), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'cloud');
      expect(outcome.remaining).toBe(0);
      expect(await docAt(Y, projectId)).toMatchObject(present('c'));
      expect((await readCanonicalBase(Y.home))?.generation).toBe(1);
      expect((await push(Y, backend, X.keys)).status).not.toBe('conflict');
    });
  });

  it('a pending merge made stale by a later `stak add .` is refused (nothing changes); push re-merges, then it resolves', async () => {
    const { backend, Y, projectId } = await conflicted('stale', 'edit', 'edit');
    await writeNative(Y, 'staged later', 'later.md');
    await stage(Y);
    const mainBefore = await readFile(canonicalFile(Y, 'main.json'), 'utf8');
    await expect(
      resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'local'),
    ).rejects.toThrow(/changed since this merge/);
    expect(await readFile(canonicalFile(Y, 'main.json'), 'utf8')).toBe(mainBefore);
    expect(await exists(mergePath(Y))).toBe(true);
    expect((await push(Y, backend)).status).toBe('conflict');
    const outcome = await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'local');
    expect(outcome.remaining).toBe(0);
    expect(await docAt(Y, projectId, 'notes/later.md')).toMatchObject(present('staged later'));
  });

  it('C6: when materialize refuses a write (native edited since), the resolution is still recorded and the refusal reported', async () => {
    const { backend, Y, projectId } = await conflicted('c6', 'edit', 'edit');
    await writeNative(Y, 'edited natively, not added');
    const outcome = await resolvePendingConflict(depsOf(Y, backend), discoveryOf(Y), projectId, 'notes/MEMORY.md', 'cloud');
    expect(outcome.remaining).toBe(0);
    expect(await docAt(Y, projectId)).toMatchObject(present('c'));
    expect(await exists(mergePath(Y))).toBe(false);
    expect(await readFile(nativeOf(Y), 'utf8')).toBe('edited natively, not added');
    expect(outcome.materialize?.conflicts.map((c) => c.path)).toContain('notes/MEMORY.md');
  });

  describe('diffPendingConflict (C7)', () => {
    it('shows both sides as text', async () => {
      const { backend, Y, projectId } = await conflicted('difftext', 'edit', 'edit');
      const diff = await diffPendingConflict(depsOf(Y, backend), projectId, 'notes/MEMORY.md');
      expect(diff).toMatchObject({ projectId, path: 'notes/MEMORY.md', reason: 'edit-edit', generation: 1 });
      expect(diff.local).toEqual({ state: 'present', text: 'b' });
      expect(diff.cloud).toEqual({ state: 'present', text: 'c' });
    });
    it('a tombstone side is "deleted", never empty text', async () => {
      const { backend, Y, projectId } = await conflicted('diffdel', 'delete', 'edit');
      const diff = await diffPendingConflict(depsOf(Y, backend), projectId, 'notes/MEMORY.md');
      expect(diff.local).toEqual({ state: 'present', text: 'b' });
      expect(diff.cloud).toEqual({ state: 'deleted' });
    });
    it('a missing side is "absent"', async () => {
      const { backend, Y, projectId } = await conflicted('diffabs', 'edit', 'absent');
      const diff = await diffPendingConflict(depsOf(Y, backend), projectId, 'notes/MEMORY.md');
      expect(diff.local).toEqual({ state: 'absent' });
      expect(diff.cloud).toEqual({ state: 'present', text: 'c' });
    });
  });

  describe('materializeMemory', () => {
    it('no args: rebuilds a deleted native folder for every located project', async () => {
      const { Y } = await synced('matall');
      await rm(path.join(Y.claude, 'projects'), { recursive: true, force: true });
      const outcome = await materializeMemory(Y.home, discoveryOf(Y));
      expect(outcome.written).toBe(2);
      expect(await readFile(nativeOf(Y), 'utf8')).toBe('a');
    });

    it('one project: written; a native edit not yet added is never overwritten (N = P rule)', async () => {
      const { Y, projectId } = await synced('matone');
      await rm(path.join(Y.claude, 'projects'), { recursive: true, force: true });
      expect((await materializeMemory(Y.home, discoveryOf(Y), { project: projectId })).written).toBe(2);
      expect(await readFile(nativeOf(Y), 'utf8')).toBe('a');
      await writeNative(Y, 'edited here');
      const again = await materializeMemory(Y.home, discoveryOf(Y), { project: projectId });
      expect(again.written).toBe(0);
      expect(await readFile(nativeOf(Y), 'utf8')).toBe('edited here');
    });

    it('one project: a native file edited since while STAK Memory also changed is reported, never overwritten', async () => {
      const { backend, X, Y, projectId } = await synced('matguard');
      await writeNative(X, 'from X');
      await stage(X);
      expect((await push(X, backend)).status).toBe('pushed');
      await writeNative(Y, 'edited on Y');
      expect((await pull(Y, backend)).status).toBe('merged'); // canonical takes X's edit; native refused
      const outcome = await materializeMemory(Y.home, discoveryOf(Y), { project: projectId });
      expect(outcome.conflicts.map((c) => c.path)).toContain('notes/MEMORY.md');
      expect(await readFile(nativeOf(Y), 'utf8')).toBe('edited on Y');
    });

    it('a project not on this machine fails with "not available on this machine" and writes nothing', async () => {
      const { Y, projectId } = await synced('matunbound');
      await writeLocalRegistry(Y.home, emptyRegistry());
      await rm(path.join(Y.claude, 'projects'), { recursive: true, force: true });
      await expect(materializeMemory(Y.home, discoveryOf(Y), { project: projectId })).rejects.toThrow(
        /not available on this machine/,
      );
      expect(await exists(nativeOf(Y))).toBe(false);
      // No-arg materialize reports it as unavailable instead, the same way push/pull do.
      const all = await materializeMemory(Y.home, discoveryOf(Y));
      expect(all.unavailable.map((p) => p.projectId)).toEqual([projectId]);
      expect(await exists(nativeOf(Y))).toBe(false);
    });

    it('an unknown project selector is rejected', async () => {
      const { Y } = await synced('matunknown');
      await expect(materializeMemory(Y.home, discoveryOf(Y), { project: 'prj_doesnotexist' })).rejects.toThrow(/No project matches/);
    });
  });
});
