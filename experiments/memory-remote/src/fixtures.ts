/**
 * Synthetic Phase 14A store fixtures for the spike tests.
 *
 * SPIKE ONLY. Builds a REAL Phase 14A store (via @stack/memory) in a temp dir
 * from entirely synthetic content. No real user Memory is ever read or uploaded.
 * Every object embeds a recognizable marker so tests can assert that plaintext
 * never leaks into logs or the simulated remote store.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  hashBytes,
  writeMemoryManifest,
  writeMemoryObject,
  type ManifestItem,
  type MemoryManifest,
} from '@stack/memory';

/** A unique marker string that must NEVER appear in logs or remote records. */
export const SECRET_MARKER = 'SYNTHETIC-SECRET-DO-NOT-LEAK';

export type SyntheticStore = {
  stackHome: string;
  manifest: MemoryManifest;
  /** contentHash for every object, to compare original vs recovered. */
  hashes: string[];
};

const gitProject = (repo: string) => ({
  kind: 'git' as const,
  canonical: `github.com/example/${repo}`,
  host: 'github.com',
  owner: 'example',
  repo,
});

/**
 * Create a synthetic store with `projects` projects and `filesPerProject` files
 * each. Returns the temp `stackHome` (caller cleans up) and the written manifest.
 */
export const writeSyntheticStore = async (options: {
  projects: number;
  filesPerProject: number;
}): Promise<SyntheticStore> => {
  const stackHome = await mkdtemp(path.join(tmpdir(), 'stack-spike-'));
  const items: ManifestItem[] = [];
  const hashes: string[] = [];

  for (let p = 0; p < options.projects; p += 1) {
    const repo = `proj${p}`;
    for (let f = 0; f < options.filesPerProject; f += 1) {
      const body = Buffer.from(
        `# ${repo} memory file ${f}\n${SECRET_MARKER} ${repo}/${f}\n`,
        'utf8',
      );
      const contentHash = hashBytes(body);
      await writeMemoryObject({ stackHome, contentHash, bytes: body });
      hashes.push(contentHash);
      items.push({
        provider: 'claude',
        kind: 'auto-memory',
        scope: 'project',
        logicalId: `claude/auto-memory/github.com/example/${repo}/f${f}.md`,
        project: gitProject(repo),
        contentHash,
        restoreTarget: {
          base: 'claude-project-memory',
          relativePath: `f${f}.md`,
        },
        capturedAt: '2026-09-24T12:00:00.000Z',
        sensitivity: 'private',
      });
    }
  }

  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-24T12:00:00.000Z',
    items,
  };
  await writeMemoryManifest({ stackHome, manifest });
  return { stackHome, manifest, hashes };
};
