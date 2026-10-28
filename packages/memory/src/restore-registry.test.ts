import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ManifestItem, MemoryManifest } from './domain.js';
import { encodeClaudeProjectKey } from './project-identity.js';
import {
  adoptReconciledProjectId,
  emptyRegistry,
  resolveOrMintProject,
  resolveProjectForIdentity,
  setBinding,
  type LocalRegistry,
} from './project/registry.js';
import { planMemoryRestore, runMemoryRestore } from './restore.js';
import { hashBytes, writeMemoryManifest, writeMemoryObject } from './store.js';

const roots: string[] = [];
const tempDir = async (prefix: string) => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

const gitProject = (canonical: string) => ({
  kind: 'git' as const,
  canonical,
  host: canonical.split('/')[0] as string,
  owner: canonical.split('/')[1] as string,
  repo: canonical.split('/')[2] as string,
});

const seed = async (
  items: Array<{
    project: ManifestItem['project'];
    rel: string;
    body: string;
  }>,
): Promise<string> => {
  const stackHome = await tempDir('stack-rr-');
  const manifestItems: ManifestItem[] = [];
  for (const { project, rel, body } of items) {
    const bytes = Buffer.from(body, 'utf8');
    const contentHash = hashBytes(bytes);
    await writeMemoryObject({ stackHome, contentHash, bytes });
    const key =
      project?.kind === 'git'
        ? project.canonical
        : `local:${project?.kind === 'local' ? project.vendorKey : ''}`;
    manifestItems.push({
      provider: 'claude',
      kind: 'auto-memory',
      scope: 'project',
      logicalId: `claude/auto-memory/${key}/${rel}`,
      ...(project ? { project } : {}),
      contentHash,
      restoreTarget: { base: 'claude-project-memory', relativePath: rel },
      capturedAt: '2026-09-27T00:00:00.000Z',
      sensitivity: 'private',
    });
  }
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-27T00:00:00.000Z',
    items: manifestItems,
  };
  await writeMemoryManifest({ stackHome, manifest });
  return stackHome;
};

const autoMemoryPath = (claudeHome: string, dir: string, rel: string) =>
  path.join(
    claudeHome,
    'projects',
    encodeClaudeProjectKey(path.resolve(dir)),
    'memory',
    rel,
  );

describe('registry-driven restore resolution', () => {
  it('a Git-backed project auto-resolves across a DIFFERENT local path', async () => {
    const stackHome = await seed([
      {
        project: gitProject('github.com/acme/atlas'),
        rel: 'a.md',
        body: 'atlas',
      },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const atlasDir = await tempDir('atlas-moved-'); // a new, different path

    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry: emptyRegistry(),
      projects: [
        { dir: atlasDir, gitRemote: 'https://github.com/acme/atlas.git' },
      ],
    });
    expect(plan.items[0]?.status).toBe('restored');
    const written = await readFile(
      autoMemoryPath(claudeHome, atlasDir, 'a.md'),
      'utf8',
    );
    expect(written).toBe('atlas');
  });

  it('a legacy local identity does NOT auto-resolve from exact path reuse', async () => {
    // Old Memory for a project that used to live here.
    const reusedDir = await tempDir('nexus-');
    const vendorKey = encodeClaudeProjectKey(path.resolve(reusedDir));
    const stackHome = await seed([
      { project: { kind: 'local', vendorKey }, rel: 'n.md', body: 'old-nexus' },
    ]);
    const claudeHome = await tempDir('stack-ch-');

    // An UNRELATED project now sits at the exact same path (no git identity).
    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry: emptyRegistry(),
      projects: [{ dir: reusedDir }],
    });
    expect(plan.items[0]?.status).toBe('project-not-found');
    // Absolutely nothing was written for the reused directory.
    await expect(
      readFile(autoMemoryPath(claudeHome, reusedDir, 'n.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it('an explicit machine binding authorizes restore of a legacy project', async () => {
    const oldDir = 'C--Users-OLD-Desktop-widget';
    const stackHome = await seed([
      {
        project: { kind: 'local', vendorKey: oldDir },
        rel: 'w.md',
        body: 'widget',
      },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const newDir = await tempDir('widget-new-');

    // Register the legacy project and bind it to the new directory.
    const { syncRegistryForBackup } =
      await import('./project/registry-store.js');
    let counter = 0;
    const sync = await syncRegistryForBackup({
      stackHome,
      mint: () => `prj_${(counter++).toString(36).padStart(26, '0')}`,
    });
    let registry: LocalRegistry = sync.registry;
    const projectId = registry.projects[0]?.projectId as string;
    registry = setBinding(registry, {
      projectId,
      dir: newDir,
      boundAt: '2026-09-27T00:00:00.000Z',
      provenance: 'user-map',
    });

    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry,
      projects: [],
    });
    expect(plan.items[0]?.status).toBe('restored');
    expect(
      await readFile(autoMemoryPath(claudeHome, newDir, 'w.md'), 'utf8'),
    ).toBe('widget');
  });

  it('a resolved legacy project is still NOT authorized by a live directory at its historical path', async () => {
    // The legacy project IS known to the registry (resolvable via its compat claim),
    // but observing a directory at the historical path must not promote that claim
    // into restore authority — only an explicit binding may.
    const historicalDir = await tempDir('historical-');
    const vendorKey = encodeClaudeProjectKey(path.resolve(historicalDir));
    const stackHome = await seed([
      { project: { kind: 'local', vendorKey }, rel: 'h.md', body: 'legacy' },
    ]);
    const { syncRegistryForBackup } =
      await import('./project/registry-store.js');
    let counter = 0;
    const { registry } = await syncRegistryForBackup({
      stackHome,
      mint: () => `prj_${(counter++).toString(36).padStart(26, '0')}`,
    });
    const { resolveProjectForIdentity } = await import('./project/registry.js');
    // Sanity: the registry resolves the legacy identity (single, no conflict)…
    expect(
      resolveProjectForIdentity(registry, { kind: 'local', vendorKey }).status,
    ).toBe('resolved');

    const claudeHome = await tempDir('stack-ch-');
    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry, // no binding present
      projects: [{ dir: historicalDir }], // a live dir at the historical path
    });
    // …yet restore is withheld: the path is not authority.
    expect(plan.items[0]?.status).toBe('project-not-found');
    await expect(
      readFile(autoMemoryPath(claudeHome, historicalDir, 'h.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it('restores resolvable projects and retains unresolved ones; second restore is idempotent', async () => {
    const legacyDir = await tempDir('legacy-');
    const vendorKey = encodeClaudeProjectKey(path.resolve(legacyDir));
    const stackHome = await seed([
      {
        project: gitProject('github.com/acme/atlas'),
        rel: 'a.md',
        body: 'atlas',
      },
      { project: { kind: 'local', vendorKey }, rel: 'n.md', body: 'nexus' },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const atlasDir = await tempDir('atlas-');

    const opts = {
      stackHome,
      claudeHome,
      registry: emptyRegistry(),
      projects: [
        { dir: atlasDir, gitRemote: 'git@github.com:acme/atlas.git' },
        { dir: legacyDir }, // path reuse — must NOT resolve the legacy identity
      ],
    };
    const first = await runMemoryRestore({ ...opts, apply: true });
    const statuses = first.items.map((i) => i.status).sort();
    expect(statuses).toEqual(['project-not-found', 'restored']);

    const second = await runMemoryRestore({ ...opts, apply: true });
    const statuses2 = second.items.map((i) => i.status).sort();
    // The restored file is now identical; the unresolved one stays retained.
    expect(statuses2).toEqual(['identical', 'project-not-found']);
  });

  it('never overwrites differing existing memory (conflict semantics intact)', async () => {
    const stackHome = await seed([
      {
        project: gitProject('github.com/acme/atlas'),
        rel: 'a.md',
        body: 'new',
      },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const atlasDir = await tempDir('atlas-');
    const target = autoMemoryPath(claudeHome, atlasDir, 'a.md');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'PRE-EXISTING', 'utf8');

    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry: emptyRegistry(),
      projects: [{ dir: atlasDir, gitRemote: 'https://github.com/acme/atlas' }],
    });
    expect(plan.items[0]?.status).toBe('conflict');
    expect(await readFile(target, 'utf8')).toBe('PRE-EXISTING');
  });

  it('refuses restore when a strong identity is claimed by two projects', async () => {
    const stackHome = await seed([
      {
        project: gitProject('github.com/acme/atlas'),
        rel: 'a.md',
        body: 'atlas',
      },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const atlasDir = await tempDir('atlas-');
    const registry: LocalRegistry = {
      schemaVersion: 1,
      projects: [
        {
          projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
          claims: [{ type: 'git', canonical: 'github.com/acme/atlas' }],
        },
        {
          projectId: 'prj_bbbbbbbbbbbbbbbbbbbbbbbbbb',
          claims: [{ type: 'git', canonical: 'github.com/acme/atlas' }],
        },
      ],
      bindings: [],
    };
    const plan = await planMemoryRestore({
      stackHome,
      claudeHome,
      registry,
      projects: [{ dir: atlasDir, gitRemote: 'https://github.com/acme/atlas' }],
    });
    expect(plan.items[0]?.status).toBe('identity-conflict');
  });

  it('resolves a generation-3-style bundle (git + legacy) without rewriting it', async () => {
    const legacyDir = await tempDir('gen3-legacy-');
    const vendorKey = encodeClaudeProjectKey(path.resolve(legacyDir));
    const stackHome = await seed([
      {
        project: gitProject('github.com/acme/atlas'),
        rel: 'a.md',
        body: 'atlas',
      },
      { project: { kind: 'local', vendorKey }, rel: 'n.md', body: 'nexus' },
    ]);
    // No snapshot present (old generation). Reconcile lazily mints Project IDs.
    const { reconcileRegistryAfterRecover } =
      await import('./project/registry-store.js');
    let counter = 0;
    const { registry } = await reconcileRegistryAfterRecover({
      stackHome,
      mint: () => `prj_${(counter++).toString(36).padStart(26, '0')}`,
    });
    expect(registry.projects).toHaveLength(2);

    const claudeHome = await tempDir('stack-ch-');
    const atlasDir = await tempDir('atlas-');
    const plan = await planMemoryRestore({
      stackHome,
      claudeHome,
      registry,
      projects: [
        { dir: atlasDir, gitRemote: 'https://github.com/acme/atlas' },
        { dir: legacyDir },
      ],
    });
    const byRel = Object.fromEntries(
      plan.items.map((i) => [i.logicalId.split('/').pop(), i.status]),
    );
    expect(byRel['a.md']).toBe('restorable'); // git resolves
    expect(byRel['n.md']).toBe('project-not-found'); // legacy stays unresolved
  });
});

/**
 * Realistic regression coverage for a real production bug: a project captured first
 * under a local path identity, later strengthened to a Git identity (the ORIGINAL
 * machine's `syncRegistryForBackup` "Local -> Git identity-strengthening" path, which
 * calls the real `adoptReconciledProjectId` — reproduced here exactly, not hand-rolled)
 * ends up as ONE registry record with BOTH claims. `stak project` already aggregates
 * both claims' files under that one record and reports it "available" via a live Git
 * directory match (`listProjects`'s `gitAutoMatch`). Restore did not use the same
 * reconciliation: a legacy-locator Memory item under a reconciled-but-not-explicitly-
 * bound local identity stayed `project-not-found` even though the SAME logical project
 * was plainly available through its Git claim.
 */
describe('restore follows canonical (reconciled) Project identity, not the historical locator', () => {
  const reconciledRegistry = (localVendorKey: string, gitCanonical: string) => {
    const minted = resolveOrMintProject(
      emptyRegistry(),
      { kind: 'local', vendorKey: localVendorKey },
      () => 'prj_localoriginal000000000001',
    );
    const withGit = resolveOrMintProject(
      minted.registry,
      gitProject(gitCanonical),
      () => 'prj_gitcanonical00000000000001',
    );
    // The exact real mechanism: adopt the stale local Project ID into the Git one.
    return adoptReconciledProjectId(
      withGit.registry,
      minted.projectId,
      withGit.projectId,
    );
  };

  it('A: a reconciled registry record carries both the legacy and Git claims under one Project ID', () => {
    const registry = reconciledRegistry(
      'C--Users-NT-Desktop-stack',
      'github.com/usestak/stak',
    );
    expect(registry.projects).toHaveLength(1);
    const record = registry.projects[0];
    expect(record?.claims).toEqual(
      expect.arrayContaining([
        { type: 'git', canonical: 'github.com/usestak/stak' },
        { type: 'legacy-compat', key: expect.stringContaining('compat:') },
      ]),
    );
    // Sanity the production symptom's premise: both identities DO resolve to the same ID.
    expect(
      resolveProjectForIdentity(registry, {
        kind: 'local',
        vendorKey: 'C--Users-NT-Desktop-stack',
      }),
    ).toEqual({ status: 'resolved', projectId: record?.projectId });
    expect(
      resolveProjectForIdentity(
        registry,
        gitProject('github.com/usestak/stak'),
      ),
    ).toEqual({ status: 'resolved', projectId: record?.projectId });
  });

  it('B/C: fresh machine, no binding — a legacy-locator item follows the live Git checkout of the SAME reconciled Project', async () => {
    const registry = reconciledRegistry(
      'C--Users-NT-Desktop-stack',
      'github.com/usestak/stak',
    );
    const stackHome = await seed([
      {
        project: gitProject('github.com/usestak/stak'),
        rel: 'MEMORY.md',
        body: 'canonical memory',
      },
      {
        project: { kind: 'local', vendorKey: 'C--Users-NT-Desktop-stack' },
        rel: 'pnpm-native-binary-fix.md',
        body: 'legacy-only note',
      },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const stakDir = await tempDir('stak-checkout-');

    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry, // reconciled, exactly as recovered from a portable snapshot
      projects: [
        { dir: stakDir, gitRemote: 'https://github.com/usestak/stak.git' },
      ],
      // NO binding at all — a genuinely fresh machine.
    });
    const byRel = Object.fromEntries(
      plan.items.map((item) => [item.logicalId.split('/').pop(), item.status]),
    );
    expect(byRel['MEMORY.md']).toBe('restored');
    // The actual regression: the legacy-locator item must follow the SAME reconciled
    // Project to the SAME live directory, not strand as project-not-found.
    expect(byRel['pnpm-native-binary-fix.md']).toBe('restored');
    expect(
      await readFile(
        autoMemoryPath(claudeHome, stakDir, 'pnpm-native-binary-fix.md'),
        'utf8',
      ),
    ).toBe('legacy-only note');
  });

  it('D: legacy and canonical entries with the SAME relative path and SAME content dedupe safely (one restored, the other identical — never a spurious conflict)', async () => {
    const registry = reconciledRegistry(
      'C--Users-NT-Desktop-stack',
      'github.com/usestak/stak',
    );
    const stackHome = await seed([
      {
        project: gitProject('github.com/usestak/stak'),
        rel: 'MEMORY.md',
        body: 'same content either way',
      },
      {
        project: { kind: 'local', vendorKey: 'C--Users-NT-Desktop-stack' },
        rel: 'MEMORY.md',
        body: 'same content either way',
      },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const stakDir = await tempDir('stak-checkout-');

    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry,
      projects: [
        { dir: stakDir, gitRemote: 'https://github.com/usestak/stak.git' },
      ],
    });
    const statuses = plan.items.map((item) => item.status).sort();
    // One writes it, the other finds identical content already there — never a
    // "conflict" for genuinely identical bytes, and never two separate writes.
    expect(statuses).toEqual(['identical', 'restored']);
    expect(
      await readFile(autoMemoryPath(claudeHome, stakDir, 'MEMORY.md'), 'utf8'),
    ).toBe('same content either way');
  });

  it('E: legacy and canonical entries with the SAME relative path but DIFFERENT content fail closed (never silently pick one)', async () => {
    const registry = reconciledRegistry(
      'C--Users-NT-Desktop-stack',
      'github.com/usestak/stak',
    );
    const stackHome = await seed([
      {
        project: gitProject('github.com/usestak/stak'),
        rel: 'MEMORY.md',
        body: 'canonical version',
      },
      {
        project: { kind: 'local', vendorKey: 'C--Users-NT-Desktop-stack' },
        rel: 'MEMORY.md',
        body: 'DIFFERENT legacy version',
      },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const stakDir = await tempDir('stak-checkout-');

    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry,
      projects: [
        { dir: stakDir, gitRemote: 'https://github.com/usestak/stak.git' },
      ],
    });
    const statuses = plan.items.map((item) => item.status).sort();
    expect(statuses).toEqual(['conflict', 'restored']);
    // Whichever one wrote first stands; the loser is reported, never silently dropped
    // or overwritten.
    const written = await readFile(
      autoMemoryPath(claudeHome, stakDir, 'MEMORY.md'),
      'utf8',
    );
    expect(['canonical version', 'DIFFERENT legacy version']).toContain(
      written,
    );
  });

  it('F: a legacy-only relative path (no canonical duplicate) still restores to the reconciled Project target', async () => {
    const registry = reconciledRegistry(
      'C--Users-NT-Desktop-stack',
      'github.com/usestak/stak',
    );
    const stackHome = await seed([
      {
        project: { kind: 'local', vendorKey: 'C--Users-NT-Desktop-stack' },
        rel: 'legacy-only-file.md',
        body: 'only ever captured locally',
      },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const stakDir = await tempDir('stak-checkout-');

    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry,
      projects: [
        { dir: stakDir, gitRemote: 'https://github.com/usestak/stak.git' },
      ],
    });
    expect(plan.items[0]?.status).toBe('restored');
    expect(
      await readFile(
        autoMemoryPath(claudeHome, stakDir, 'legacy-only-file.md'),
        'utf8',
      ),
    ).toBe('only ever captured locally');
  });

  it('G: with NO reconciliation at all, a legacy locator still never auto-resolves from path/name similarity (unchanged safety)', async () => {
    const stackHome = await seed([
      {
        project: { kind: 'local', vendorKey: 'C--Users-NT-Desktop-stack' },
        rel: 'note.md',
        body: 'unreconciled',
      },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const stakDir = await tempDir('stak-checkout-');
    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry: emptyRegistry(), // no reconciliation, no binding
      projects: [
        { dir: stakDir, gitRemote: 'https://github.com/usestak/stak.git' },
      ],
    });
    expect(plan.items[0]?.status).toBe('project-not-found');
  });

  it('H: an UNRELATED local Project is never merged into an available Git Project just because both are "available"', async () => {
    // Two genuinely distinct logical projects: one reconciled to a live Git checkout,
    // one local-only and NOT reconciled with it. The second must stay unresolved —
    // availability of the first must never bleed into the second.
    const reconciled = reconciledRegistry(
      'C--Users-NT-Desktop-stack',
      'github.com/usestak/stak',
    );
    const unrelated = resolveOrMintProject(
      reconciled,
      { kind: 'local', vendorKey: 'C--Users-NT-Desktop-other-project' },
      () => 'prj_unrelatedlocal00000000001',
    ).registry;
    expect(unrelated.projects).toHaveLength(2);

    const stackHome = await seed([
      {
        project: { kind: 'local', vendorKey: 'C--Users-NT-Desktop-stack' },
        rel: 'reconciled.md',
        body: 'belongs to stak',
      },
      {
        project: {
          kind: 'local',
          vendorKey: 'C--Users-NT-Desktop-other-project',
        },
        rel: 'unrelated.md',
        body: 'does not belong to stak',
      },
    ]);
    const claudeHome = await tempDir('stack-ch-');
    const stakDir = await tempDir('stak-checkout-');
    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry: unrelated,
      projects: [
        { dir: stakDir, gitRemote: 'https://github.com/usestak/stak.git' },
      ],
    });
    const byRel = Object.fromEntries(
      plan.items.map((item) => [item.logicalId.split('/').pop(), item.status]),
    );
    expect(byRel['reconciled.md']).toBe('restored');
    // The unrelated local project has no Git claim and no binding — stays unresolved.
    expect(byRel['unrelated.md']).toBe('project-not-found');
  });
});
