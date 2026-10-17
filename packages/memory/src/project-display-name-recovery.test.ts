import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeMemoryAdapter } from './adapter.js';
import { encodeClaudeProjectKey } from './project-identity.js';
import {
  emptyRegistry,
  mergePortableSnapshot,
  nameHintFor,
} from './project/registry.js';
import {
  readLocalRegistry,
  readPortableSnapshot,
} from './project/registry-store.js';

const roots: string[] = [];
const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

const isDirectory = async (candidate: string): Promise<boolean> => {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
};

describe('Project display name — Machine A discovery to Machine B recovery (spec §16 A-E)', () => {
  it('names the project on Machine A, keeps the name OUT of the portable snapshot, and Machine B recovers the same projectId with no name hint of its own', async () => {
    // Machine A: a real local project directory with auto-memory, no Git remote.
    const claudeHomeA = await tempDir('claude-a-');
    const checkout = path.join(await tempDir('repos-'), 'nexus');
    await mkdir(checkout, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(checkout);
    const memoryDir = path.join(claudeHomeA, 'projects', vendorKey, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, 'n1.md'), '# nexus notes\n', 'utf8');

    const stackHomeA = await tempDir('stack-a-');
    const adapterA = createClaudeMemoryAdapter({
      stackHome: stackHomeA,
      claudeHome: claudeHomeA,
      platform: process.platform,
      gitRemoteOf: async () => undefined,
      isDirectory,
    });

    await adapterA.backup();

    const registryA = await readLocalRegistry(stackHomeA);
    const record = registryA.projects[0];
    if (!record) throw new Error('expected a minted project record');
    const projectId = record.projectId;

    // A. Machine A: stable projectId minted, displayName hint = basename, no path anywhere.
    expect(nameHintFor(registryA, projectId)).toBe('nexus');

    // B. The portable snapshot (what a Cloud bundle would carry) has no name and no path.
    const snapshot = await readPortableSnapshot(stackHomeA);
    if (!snapshot) throw new Error('expected a portable snapshot');
    expect(JSON.stringify(snapshot)).not.toContain('nexus');
    expect(JSON.stringify(snapshot)).not.toMatch(/[A-Za-z]:\\|\/Users\//);

    // C. Machine B recovers the SAME portable snapshot into an empty local registry.
    const merged = mergePortableSnapshot(emptyRegistry(), snapshot);
    expect(merged.conflicts).toEqual([]);
    const recordB = merged.registry.projects.find(
      (p) => p.projectId === projectId,
    );
    expect(recordB).toBeDefined();

    // D/E. Machine B has the SAME projectId, but NO name hint and NO binding of its own —
    // it cannot render "nexus" until either Cloud supplies it or a local `stak project
    // map` creates a fresh binding. Identity never flows through the name.
    expect(nameHintFor(merged.registry, projectId)).toBeUndefined();
    expect(merged.registry.bindings).toEqual([]);
  });
});
