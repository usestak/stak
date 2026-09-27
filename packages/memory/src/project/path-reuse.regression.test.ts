import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ManifestItem, MemoryManifest } from '../domain.js';
import { encodeClaudeProjectKey } from '../project-identity.js';
import { reconcileRegistryAfterRecover } from './registry-store.js';
import { runMemoryRestore } from '../restore.js';
import { hashBytes, writeMemoryManifest, writeMemoryObject } from '../store.js';

/**
 * CRITICAL, PERMANENT regression for the real path-reuse hazard found in the Phase
 * 14B dogfood (see docs/architecture/project-identity.md §12). Legacy Memory keyed by
 * an old absolute path must NEVER be auto-restored into an unrelated directory that
 * later occupies the same path. Do not delete this test.
 */
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

describe('path-reuse safety (regression)', () => {
  it('old Nexus Memory is NOT restored into an unrelated project at the same reused path', async () => {
    // 1. Machine A had a project at some path; its Memory is keyed by that path.
    const nexusPath = await tempDir('Desktop-nexus-');
    const legacyVendorKey = encodeClaudeProjectKey(path.resolve(nexusPath));

    const stackHome = await tempDir('stack-pr-');
    const body = Buffer.from('SECRET nexus memory\n', 'utf8');
    const contentHash = hashBytes(body);
    await writeMemoryObject({ stackHome, contentHash, bytes: body });
    const item: ManifestItem = {
      provider: 'claude',
      kind: 'auto-memory',
      scope: 'project',
      logicalId: `claude/auto-memory/local:${legacyVendorKey}/notes.md`,
      project: { kind: 'local', vendorKey: legacyVendorKey },
      contentHash,
      restoreTarget: {
        base: 'claude-project-memory',
        relativePath: 'notes.md',
      },
      capturedAt: '2026-09-27T00:00:00.000Z',
      sensitivity: 'private',
    };
    const manifest: MemoryManifest = {
      schemaVersion: 1,
      provider: 'claude',
      createdAt: '2026-09-27T00:00:00.000Z',
      items: [item],
    };
    await writeMemoryManifest({ stackHome, manifest });

    // 2/3. The old project is gone; an unrelated project now sits at the SAME path.
    // 4. Stack evaluates restore, with the registry reconciled (lazy Project ID).
    let counter = 0;
    const { registry } = await reconcileRegistryAfterRecover({
      stackHome,
      mint: () => `prj_${(counter++).toString(36).padStart(26, '0')}`,
    });
    const claudeHome = await tempDir('stack-ch-');
    const plan = await runMemoryRestore({
      stackHome,
      claudeHome,
      apply: true,
      registry,
      projects: [{ dir: nexusPath }], // unrelated project, same path, no git
    });

    // 5/6. MUST remain unresolved with zero native writes; explicit mapping required.
    expect(plan.items[0]?.status).toBe('project-not-found');
    await expect(
      readFile(
        path.join(
          claudeHome,
          'projects',
          encodeClaudeProjectKey(path.resolve(nexusPath)),
          'memory',
          'notes.md',
        ),
        'utf8',
      ),
    ).rejects.toThrow();
  });
});
