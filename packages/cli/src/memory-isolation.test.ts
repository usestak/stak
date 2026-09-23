import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildPublicStackBundle } from '@stack/core';
import type { ImportedStackVersion } from '@stack/spec';
import {
  hashBytes,
  memoryStorePaths,
  writeMemoryManifest,
  writeMemoryObject,
} from '@stack/memory';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-mem-iso-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const MEMORY_SECRET = 'PRIVATE-MEMORY-SECRET-DO-NOT-PUBLISH';

const referenceVersion = (): ImportedStackVersion => ({
  schemaVersion: 1,
  name: 'frontend',
  description: 'frontend stack',
  versionHash: `sha256:${'a'.repeat(64)}`,
  requirements: [
    {
      id: 'req_designengineer',
      name: 'design',
      requirement: 'required',
      contentHash: `sha256:${'b'.repeat(64)}`,
      metadata: { name: 'design', description: 'Design engineering' },
      restoration: {
        strategy: 'reference',
        reference: {
          remote: 'https://github.com/example/design.git',
          revision: 'a'.repeat(40),
          path: 'design',
          expectedContentHash: `sha256:${'b'.repeat(64)}`,
        },
      },
      observedSources: [],
      originStackName: 'frontend',
    },
  ],
  inheritedStacks: [],
  skippedOptional: [],
});

describe('memory is isolated from public publishing', () => {
  it('the Memory store namespace is disjoint from the Skill store', async () => {
    const stackHome = await temp();
    expect(memoryStorePaths(stackHome).root).toBe(
      path.join(path.resolve(stackHome), 'memory'),
    );
    // Publishing/Skills use `<stackHome>/store`; Memory never collides with it.
    expect(memoryStorePaths(stackHome).root.endsWith(`${path.sep}memory`)).toBe(
      true,
    );
  });

  it('a public bundle never contains memory content or references', async () => {
    const stackHome = await temp();
    // A real private memory backup sits under the same STACK_HOME.
    const bytes = Buffer.from(MEMORY_SECRET);
    const contentHash = hashBytes(bytes);
    await writeMemoryObject({ stackHome, contentHash, bytes });
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-09-23T12:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'user-instructions',
            scope: 'global',
            logicalId: 'claude/user-instructions/global/CLAUDE.md',
            contentHash,
            restoreTarget: { base: 'claude-home', relativePath: 'CLAUDE.md' },
            capturedAt: '2026-09-23T12:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });

    // The publish transform reads only the Stack version — never STACK_HOME/memory.
    const bundle = buildPublicStackBundle(referenceVersion());
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(MEMORY_SECRET);
    expect(serialized).not.toContain(contentHash);
    expect(serialized).not.toContain('memory');
    expect(Object.keys(bundle)).not.toContain('memory');
    // The bundle only exposes the reference-backed Skill.
    expect(bundle.requirements.map((requirement) => requirement.name)).toEqual([
      'design',
    ]);
  });
});
