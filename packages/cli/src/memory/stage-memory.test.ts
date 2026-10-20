import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  emptyRegistry,
  encodeClaudeProjectKey,
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

  it('does NOT dedupe when old + new locations genuinely differ in content', async () => {
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

    // Genuinely different content at the same logical identity: never silently
    // merged — both copies are staged distinctly.
    expect(result.files).toBe(2);
  });
});
