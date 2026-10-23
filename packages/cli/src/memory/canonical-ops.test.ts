import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CANONICAL_MAIN_SCHEMA_VERSION,
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

import {
  canonicalMemoryStatus,
  materializeCanonicalProjects,
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
      // The edit is NOT overwritten and the deletion is NOT re-materialized…
      expect(await readFile(path.join(nativeDir, 'a.md'), 'utf8')).toBe('edited since add');
      expect(await exists(path.join(nativeDir, 'b.md'))).toBe(false);
      // …and both show up as ordinary pending changes, never as conflicts.
      const status = await canonicalMemoryStatus(stackHome, discovery);
      expect(status.projects).toHaveLength(1);
      expect(status.projects[0]?.conflicts).toEqual([]);
      expect(status.projects[0]?.pending).toBe(2);
      // `stak add .` imports the edit and records the deletion.
      const staged = await stageCanonicalMemory(stackHome, discovery);
      expect(staged.projects[0]?.imported.sort()).toEqual(['notes/a.md', 'notes/b.md']);
      const main = await readCanonicalMain(stackHome);
      const docs = main.projects[0]?.documents ?? [];
      expect(docs.find((d) => d.path === 'notes/a.md')).toMatchObject({ state: 'present', contentHash: hashBytes(Buffer.from('edited since add')) });
      expect(docs.find((d) => d.path === 'notes/b.md')?.state).toBe('deleted');
    };

    it('first migration via `stak pull`: an edited file is an import-edit (not a conflict); a deleted file is an import-delete (not re-materialized)', async () => {
      const { nativeDir, discovery } = await establishedV1Machine();
      const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r3-established-pull');
      const pulled = await pullMemoryViaCanonical(deps(stackHome, backend, path.join(root, 'keys')), discovery);
      expect(pulled.status).toBe('up-to-date');
      expect(pulled.conflicts ?? []).toEqual([]);
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
      // A later pull materializes nothing over the user's native state.
      await pullMemoryViaCanonical(deps(stackHome, backend, keys), discovery);
      await assertNormalChanges(nativeDir, discovery);
    });

    it('first migration via the default `stak memory backup` migrate (no locator) seeds a local manifest too', async () => {
      const { nativeDir, discovery } = await establishedV1Machine();
      const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'r3-established-backup-default');
      const keys = path.join(root, 'keys');
      await runMemoryCloudBackup(deps(stackHome, backend, keys));
      await pullMemoryViaCanonical(deps(stackHome, backend, keys), discovery);
      await assertNormalChanges(nativeDir, discovery);
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

      // Re-run protect: resumes with this device's key and finalizes.
      const resumed = await runMemoryCloudProtect({ ...deps(stackHome, backend, keys), backend }, { recoveryKey: generateRecoveryKey() });
      expect(resumed).toMatchObject({ status: 'protected', migrated: 0 });
      expect((await backend.getProfile())?.privacyMode).toBe('protected');
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
