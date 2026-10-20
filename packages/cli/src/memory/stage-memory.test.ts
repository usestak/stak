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
  it('H: old + new Claude auto-memory folders for the SAME reconciled Project, same content — stages ONE logical record, not two', async () => {
    const stackHome = await temp('stack-stage-');
    const claudeHome = await temp('claude-home-');
    const newProjectDir = await temp('swft-fresh-');

    const oldVendorKey = 'C--Users-NT-Desktop-swft';
    const newVendorKey = encodeClaudeProjectKey(path.resolve(newProjectDir));

    // Claude's own per-directory Memory folders for BOTH the stale old location and
    // the current one — exactly the real production discovery.
    await write(
      path.join(claudeHome, 'projects', oldVendorKey, 'memory', 'feedback.md'),
      'same feedback content',
    );
    await write(
      path.join(claudeHome, 'projects', newVendorKey, 'memory', 'feedback.md'),
      'same feedback content',
    );

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

    expect(result.files).toBe(1);
    const manifest = await readMemoryManifest(stackHome);
    const feedbackEntries = manifest?.items.filter((item) =>
      item.logicalId.endsWith('feedback.md'),
    );
    expect(feedbackEntries).toHaveLength(1);
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

  it('reproduces the exact production regression: starting from an EXISTING staged MAIN entry under the OLD locator, relocating and re-running `stak add .` is fully idempotent — no duplicate file, no duplicate Project', async () => {
    const stackHome = await temp('stack-stage-');
    const claudeHome = await temp('claude-home-');
    const oldProjectDir = await temp('swft-original-');
    const newProjectDir = await temp('swft-fresh-');

    const oldVendorKey = encodeClaudeProjectKey(path.resolve(oldProjectDir));
    await write(
      path.join(claudeHome, 'projects', oldVendorKey, 'memory', 'feedback.md'),
      'feedback content',
    );

    // Step 1: stage from the ORIGINAL location — this is the pre-existing MAIN state
    // (the real "30 files / 10 projects" baseline before relocation).
    const initial = await stageMemoryWithProjectDedup({
      stackHome,
      claudeHome,
      projects: [{ dir: oldProjectDir }],
    });
    expect(initial.files).toBe(1);
    const registryAfterInitial = await readLocalRegistry(stackHome);
    expect(registryAfterInitial.projects).toHaveLength(1);
    const projectId = registryAfterInitial.projects[0]?.projectId;

    // Step 2 (the relocation): the project moves to a new directory. Claude's own
    // per-directory Memory folder for the OLD directory still exists on disk (real,
    // observed production behavior — Claude never deletes it), alongside the freshly
    // discovered new one, with byte-identical content.
    const newVendorKey = encodeClaudeProjectKey(path.resolve(newProjectDir));
    await write(
      path.join(claudeHome, 'projects', newVendorKey, 'memory', 'feedback.md'),
      'feedback content',
    );
    let registry = await readLocalRegistry(stackHome);
    registry = setBinding(registry, {
      projectId: projectId as string,
      dir: path.resolve(newProjectDir),
      boundAt: '2026-10-20T00:00:00.000Z',
      provenance: 'user-map',
    });
    await writeLocalRegistry(stackHome, registry);

    // Step 3: `stak add .` after relocation — native discovery now reports BOTH the
    // stale old-location copy AND the new one. Staging MUST reconcile against the
    // EXISTING staged MAIN entry, not just against the two native copies: the result
    // must be a true no-op, not a second file/Project record.
    const afterRelocation = await stageMemoryWithProjectDedup({
      stackHome,
      claudeHome,
      projects: [{ dir: oldProjectDir }, { dir: newProjectDir }],
    });
    expect(afterRelocation.files).toBe(1);

    const manifest = await readMemoryManifest(stackHome);
    expect(manifest?.items).toHaveLength(1);

    const registryAfterAdd = await readLocalRegistry(stackHome);
    expect(registryAfterAdd.projects).toHaveLength(1);
    expect(registryAfterAdd.projects[0]?.projectId).toBe(projectId);

    // Step 4: running `stak add .` again must be fully idempotent.
    const second = await stageMemoryWithProjectDedup({
      stackHome,
      claudeHome,
      projects: [{ dir: oldProjectDir }, { dir: newProjectDir }],
    });
    expect(second.files).toBe(1);
    const manifestAfterSecond = await readMemoryManifest(stackHome);
    expect(manifestAfterSecond?.items).toHaveLength(1);
    const registryAfterSecond = await readLocalRegistry(stackHome);
    expect(registryAfterSecond.projects).toHaveLength(1);
  });
});
