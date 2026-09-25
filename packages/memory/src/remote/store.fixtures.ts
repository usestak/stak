/**
 * Synthetic Phase 14A store fixtures for remote-Memory tests. NOT shipped
 * (excluded from the build). Builds a REAL store via the content-addressed store
 * from entirely synthetic content; every object embeds a marker so tests can prove
 * plaintext never leaks into logs or remote records.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ManifestItem, MemoryManifest } from '../domain.js';
import { hashBytes, writeMemoryManifest, writeMemoryObject } from '../store.js';

export const SECRET_MARKER = 'SYNTHETIC-SECRET-DO-NOT-LEAK';

export type SyntheticStore = {
  stackHome: string;
  manifest: MemoryManifest;
  hashes: string[];
};

const gitProject = (repo: string) => ({
  kind: 'git' as const,
  canonical: `github.com/example/${repo}`,
  host: 'github.com',
  owner: 'example',
  repo,
});

export const writeSyntheticStore = async (options: {
  projects: number;
  filesPerProject: number;
}): Promise<SyntheticStore> => {
  const stackHome = await mkdtemp(path.join(tmpdir(), 'stack-14b-'));
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
        capturedAt: '2026-09-25T12:00:00.000Z',
        sensitivity: 'private',
      });
    }
  }
  const manifest: MemoryManifest = {
    schemaVersion: 1,
    provider: 'claude',
    createdAt: '2026-09-25T12:00:00.000Z',
    items,
  };
  await writeMemoryManifest({ stackHome, manifest });
  return { stackHome, manifest, hashes };
};
