import type { DiscoveredMemoryItem } from './domain.js';
import {
  detectClaudeMemory,
  discoverClaudeMemory,
  type ClaudeProjectInput,
  type MemoryDetection,
} from './claude-adapter.js';
import {
  planMemoryBackup,
  runMemoryBackup,
  type BackupPlan,
  type BackupResult,
} from './backup.js';
import {
  planMemoryRestore,
  runMemoryRestore,
  type RestorePlan,
} from './restore.js';
import { readMemoryManifest } from './store.js';

export type MemoryVerifyResult = {
  ok: boolean;
  checked: number;
  corrupt: string[];
};

/**
 * Provider-agnostic memory surface. Future providers may register but report
 * `unsupported` / `no portable memory discovered` until a stable contract exists.
 */
export interface MemoryAdapter {
  readonly provider: string;
  detect(): Promise<MemoryDetection>;
  discover(): Promise<DiscoveredMemoryItem[]>;
  planBackup(): Promise<BackupPlan>;
  backup(): Promise<BackupResult>;
  planRestore(): Promise<RestorePlan>;
  restore(options: { apply: boolean }): Promise<RestorePlan>;
  verify(): Promise<MemoryVerifyResult>;
}

export type ClaudeMemoryAdapterOptions = {
  stackHome: string;
  claudeHome?: string;
  projects?: ClaudeProjectInput[];
  now?: () => Date;
};

export const createClaudeMemoryAdapter = (
  options: ClaudeMemoryAdapterOptions,
): MemoryAdapter => {
  const discoveryOptions = {
    ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
    ...(options.projects ? { projects: options.projects } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  return {
    provider: 'claude',
    detect: () => detectClaudeMemory(discoveryOptions),
    discover: () => discoverClaudeMemory(discoveryOptions),
    planBackup: async () =>
      planMemoryBackup(await discoverClaudeMemory(discoveryOptions)),
    backup: async () =>
      runMemoryBackup({
        stackHome: options.stackHome,
        items: await discoverClaudeMemory(discoveryOptions),
        ...(options.now ? { now: options.now } : {}),
      }),
    planRestore: () =>
      planMemoryRestore({
        stackHome: options.stackHome,
        ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
        ...(options.projects ? { projects: options.projects } : {}),
      }),
    restore: ({ apply }) =>
      runMemoryRestore({
        stackHome: options.stackHome,
        apply,
        ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
        ...(options.projects ? { projects: options.projects } : {}),
      }),
    verify: async () => {
      const manifest = await readMemoryManifest(options.stackHome);
      const items = manifest?.items ?? [];
      const corrupt: string[] = [];
      for (const item of items) {
        try {
          const { readMemoryObject } = await import('./store.js');
          await readMemoryObject({
            stackHome: options.stackHome,
            contentHash: item.contentHash,
          });
        } catch {
          corrupt.push(item.logicalId);
        }
      }
      return { ok: corrupt.length === 0, checked: items.length, corrupt };
    },
  };
};

/**
 * Placeholder for providers without a verified portable-memory contract (Codex,
 * Cursor). It reports honestly rather than faking capture.
 */
export const unsupportedMemoryAdapter = (
  provider: string,
  reason: string,
): MemoryAdapter => ({
  provider,
  detect: async () => ({ installed: false, reason }),
  discover: async () => [],
  planBackup: async () => ({ provider: 'claude', files: 0, projects: 0 }),
  backup: async () => ({
    provider: 'claude',
    files: 0,
    projects: 0,
    createdAt: new Date(0).toISOString(),
  }),
  planRestore: async () => ({
    provider: 'claude',
    files: 0,
    projects: 0,
    items: [],
  }),
  restore: async () => ({
    provider: 'claude',
    files: 0,
    projects: 0,
    items: [],
  }),
  verify: async () => ({ ok: true, checked: 0, corrupt: [] }),
});

export type MemoryStatus = {
  provider: 'claude';
  projects: number;
  files: number;
  lastBackupAt: string | null;
};

/** Summarize the last committed backup, or null when none exists. */
export const readMemoryStatus = async (
  stackHome: string,
): Promise<MemoryStatus | null> => {
  const manifest = await readMemoryManifest(stackHome);
  if (!manifest) return null;
  const projects = new Set(
    manifest.items
      .filter((item) => item.scope === 'project' && item.project)
      .map((item) =>
        item.project?.kind === 'git'
          ? item.project.canonical
          : `local:${item.project?.kind === 'local' ? item.project.vendorKey : ''}`,
      ),
  ).size;
  return {
    provider: 'claude',
    projects,
    files: manifest.items.length,
    lastBackupAt: manifest.createdAt,
  };
};
