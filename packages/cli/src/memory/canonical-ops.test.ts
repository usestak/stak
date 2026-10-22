import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setBinding, writeLocalRegistry, readLocalRegistry, resolveOrMintProject } from '@stack/memory';

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

describe('stageCanonicalMemory', () => {
  it('imports a native edit for a bound project and reports it', async () => {
    const projectId = await bindProject(projectDir);
    await mkdir(path.dirname(path.join(projectDir, 'CLAUDE.local.md')), { recursive: true });
    await writeFile(path.join(projectDir, 'CLAUDE.local.md'), 'private memory');

    const summaries = await stageCanonicalMemory(stackHome, { claudeHome });
    const mine = summaries.find((s) => s.projectId === projectId);
    expect(mine?.imported).toContain('instructions/private.md');
  });

  it('is read-only in canonicalMemoryStatus (does not import)', async () => {
    const projectId = await bindProject(projectDir);
    await writeFile(path.join(projectDir, 'CLAUDE.local.md'), 'private memory');

    const summaries = await canonicalMemoryStatus(stackHome, { claudeHome });
    expect(summaries.find((s) => s.projectId === projectId)?.imported).toEqual([]);
    // Confirm nothing was actually staged.
    const after = await canonicalMemoryStatus(stackHome, { claudeHome });
    expect(after.find((s) => s.projectId === projectId)?.imported).toEqual([]);
  });
});
