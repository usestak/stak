import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  emptyRegistry,
  encodeClaudeProjectKey,
  readLocalRegistry,
  readMemoryManifest,
  mintProjectId,
  resolveOrMintProject,
  setBinding,
  writeLocalRegistry,
} from '@stack/memory';

import { stageMemoryWithProjectDedup } from './stage-memory.js';

const roots: string[] = [];
const temp = async (prefix: string) => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const write = async (file: string, body: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, 'utf8');
};

describe('stageMemoryWithProjectDedup — `stak add .` after relocation', () => {
  it('global-only scoping: project-scope auto-memory (even duplicated across the SAME reconciled Project) is EXCLUDED — it now goes through canonical staging, not the v1 manifest — while a global item still stages normally', async () => {
    const stackHome = await temp('stack-stage-');
    const claudeHome = await temp('claude-home-');
    const newProjectDir = await temp('swft-fresh-');

    const oldVendorKey = 'C--Users-NT-Desktop-swft';
    const newVendorKey = encodeClaudeProjectKey(path.resolve(newProjectDir));

    // Claude's own per-directory Memory folders for BOTH the stale old location and
    // the current one — exactly the real production discovery. This is project-scope
    // Memory: it must be excluded from this v1 path entirely now (spec 9.1 step 5).
    await write(
      path.join(claudeHome, 'projects', oldVendorKey, 'memory', 'feedback.md'),
      'same feedback content',
    );
    await write(
      path.join(claudeHome, 'projects', newVendorKey, 'memory', 'feedback.md'),
      'same feedback content',
    );
    // A genuinely global item — `stak add .`'s v1 staging still owns this.
    await write(path.join(claudeHome, 'CLAUDE.md'), 'global instructions');

    // Reconcile: the old vendor key is a known (claimed) Project; the new directory
    // is explicitly mapped (bound, not claimed) to the SAME Project — exactly the
    // real `stak project map` flow.
    const minted = resolveOrMintProject(
      emptyRegistry(),
      { kind: 'local', vendorKey: oldVendorKey },
      mintProjectId,
    );
    const reconciled = setBinding(minted.registry, {
      projectId: minted.projectId,
      dir: path.resolve(newProjectDir),
      boundAt: '2026-10-20T00:00:00.000Z',
      provenance: 'user-map',
    });
    await writeLocalRegistry(stackHome, reconciled);

    const result = await stageMemoryWithProjectDedup({
      stackHome,
      claudeHome,
      projects: [{ dir: newProjectDir }],
    });

    // Only the global item stages — the dedup machinery never even sees the
    // project-scope auto-memory copies, so there is nothing to dedup here anymore.
    expect(result.files).toBe(1);
    const manifest = await readMemoryManifest(stackHome);
    const feedbackEntries = manifest?.items.filter((item) =>
      item.logicalId.endsWith('feedback.md'),
    );
    expect(feedbackEntries).toHaveLength(0);
    const globalEntries = manifest?.items.filter(
      (item) => item.scope === 'global',
    );
    expect(globalEntries).toHaveLength(1);
  });

  it('fails closed (stages neither copy) when old + new locations genuinely differ in content — never two portable records, never an arbitrary pick', async () => {
    const stackHome = await temp('stack-stage-');
    const claudeHome = await temp('claude-home-');
    const newProjectDir = await temp('swft-fresh-');

    const oldVendorKey = 'C--Users-NT-Desktop-swft';
    const newVendorKey = encodeClaudeProjectKey(path.resolve(newProjectDir));

    await write(
      path.join(claudeHome, 'projects', oldVendorKey, 'memory', 'feedback.md'),
      'old content',
    );
    await write(
      path.join(claudeHome, 'projects', newVendorKey, 'memory', 'feedback.md'),
      'edited content',
    );

    const minted = resolveOrMintProject(
      emptyRegistry(),
      { kind: 'local', vendorKey: oldVendorKey },
      mintProjectId,
    );
    const reconciled = setBinding(minted.registry, {
      projectId: minted.projectId,
      dir: path.resolve(newProjectDir),
      boundAt: '2026-10-20T00:00:00.000Z',
      provenance: 'user-map',
    });
    await writeLocalRegistry(stackHome, reconciled);

    const result = await stageMemoryWithProjectDedup({
      stackHome,
      claudeHome,
      projects: [{ dir: newProjectDir }],
    });

    // Genuinely different content at the same logical identity, with NO existing
    // staged entry to reconcile against: fails closed — neither copy is committed as
    // a portable record (never two records, never an arbitrary silent pick). The
    // disagreement surfaces instead as a working-tree "changes not added" state for
    // the user to resolve explicitly.
    expect(result.files).toBe(0);
  });

  it('what used to be the exact production regression (relocation dedup) now stays a no-op across relocation and repeat runs — project-scope auto-memory never reaches the v1 manifest or this path\'s registry sync at all', async () => {
    const stackHome = await temp('stack-stage-');
    const claudeHome = await temp('claude-home-');
    const oldProjectDir = await temp('swft-original-');
    const newProjectDir = await temp('swft-fresh-');

    const oldVendorKey = encodeClaudeProjectKey(path.resolve(oldProjectDir));
    await write(
      path.join(claudeHome, 'projects', oldVendorKey, 'memory', 'feedback.md'),
      'feedback content',
    );

    // Step 1: stage from the ORIGINAL location. Project-scope auto-memory is
    // excluded from this v1 path entirely now (it's canonical Memory's job via
    // `stageCanonicalMemory`), so nothing stages and this path's registry sync
    // (`syncRegistryForBackup`, driven off project-scope vendor keys) never mints
    // a Project either.
    const initial = await stageMemoryWithProjectDedup({
      stackHome,
      claudeHome,
      projects: [{ dir: oldProjectDir }],
    });
    expect(initial.files).toBe(0);
    const registryAfterInitial = await readLocalRegistry(stackHome);
    expect(registryAfterInitial.projects).toHaveLength(0);

    // Step 2 (the relocation): the project moves to a new directory. Claude's own
    // per-directory Memory folder for the OLD directory still exists on disk (real,
    // observed production behavior — Claude never deletes it), alongside the freshly
    // discovered new one, with byte-identical content. (No registry binding needed
    // here anymore — there is no Project ID to bind to, since none was minted.)
    const newVendorKey = encodeClaudeProjectKey(path.resolve(newProjectDir));
    await write(
      path.join(claudeHome, 'projects', newVendorKey, 'memory', 'feedback.md'),
      'feedback content',
    );

    // Step 3: `stak add .` after relocation — native discovery now reports BOTH the
    // stale old-location copy AND the new one. Both remain excluded; still a no-op.
    const afterRelocation = await stageMemoryWithProjectDedup({
      stackHome,
      claudeHome,
      projects: [{ dir: oldProjectDir }, { dir: newProjectDir }],
    });
    expect(afterRelocation.files).toBe(0);

    const manifest = await readMemoryManifest(stackHome);
    expect(manifest?.items ?? []).toHaveLength(0);

    const registryAfterAdd = await readLocalRegistry(stackHome);
    expect(registryAfterAdd.projects).toHaveLength(0);

    // Step 4: running `stak add .` again must be fully idempotent.
    const second = await stageMemoryWithProjectDedup({
      stackHome,
      claudeHome,
      projects: [{ dir: oldProjectDir }, { dir: newProjectDir }],
    });
    expect(second.files).toBe(0);
    const manifestAfterSecond = await readMemoryManifest(stackHome);
    expect(manifestAfterSecond?.items ?? []).toHaveLength(0);
    const registryAfterSecond = await readLocalRegistry(stackHome);
    expect(registryAfterSecond.projects).toHaveLength(0);
  });
});
