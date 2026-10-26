import type { DiscoveredMemoryItem } from './domain.js';
import {
  detectClaudeMemory,
  discoverClaudeMemory,
  type ClaudeProjectInput,
  type MemoryDetection,
} from './claude-adapter.js';
import {
  planMemoryBackup,
  planMemoryBackupComposition,
  runMemoryBackup,
  type BackupComposition,
  type BackupPlan,
  type BackupResult,
} from './backup.js';
import {
  planMemoryRestore,
  runMemoryRestore,
  type RestorePlan,
} from './restore.js';
import { readMemoryManifest } from './store.js';
import { readCanonicalMain } from './canonical/store.js';
import {
  readLocalRegistry,
  syncRegistryForBackup,
} from './project/registry-store.js';
import {
  projectIdentityKey,
  safeDirectoryBasename,
} from './project-identity.js';

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
  /** Non-mutating preview of the next backup's composition (Phase 15B.3). */
  previewBackup(): Promise<BackupComposition>;
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
  platform?: NodeJS.Platform;
  gitRemoteOf?: (dir: string) => Promise<string | undefined>;
  isDirectory?: (candidate: string) => Promise<boolean>;
};

export const createClaudeMemoryAdapter = (
  options: ClaudeMemoryAdapterOptions,
): MemoryAdapter => {
  const discoveryOptions = {
    ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
    ...(options.projects ? { projects: options.projects } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.gitRemoteOf ? { gitRemoteOf: options.gitRemoteOf } : {}),
    ...(options.isDirectory ? { isDirectory: options.isDirectory } : {}),
  };
  return {
    provider: 'claude',
    detect: () => detectClaudeMemory(discoveryOptions),
    discover: () => discoverClaudeMemory(discoveryOptions),
    planBackup: async () =>
      planMemoryBackup(await discoverClaudeMemory(discoveryOptions)),
    previewBackup: async () =>
      planMemoryBackupComposition({
        stackHome: options.stackHome,
        nativeItems: await discoverClaudeMemory(discoveryOptions),
        registry: await readLocalRegistry(options.stackHome),
        ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
        ...(options.projects ? { projects: options.projects } : {}),
      }),
    backup: async () => {
      const nameHints = new Map<string, string>();
      const nativeItems = await discoverClaudeMemory({
        ...discoveryOptions,
        onLocalProjectResolved: (vendorKey, dir) => {
          const base = safeDirectoryBasename(dir);
          if (base) nameHints.set(vendorKey, base);
        },
      });
      // identityKey -> vendor key, from the live (pre-portable-strip) items, so a
      // Git-resolved identity's vendor key survives for Bug-B zombie retirement even
      // though the portable manifest never carries one for Git identities.
      const vendorKeys = new Map<string, string>();
      for (const item of nativeItems) {
        if (item.scope !== 'project' || !item.project || !item.source.vendorKey)
          continue;
        vendorKeys.set(projectIdentityKey(item.project), item.source.vendorKey);
      }
      // Phase 15B.3: compose the next backup as the native scan PLUS previously
      // backed-up Memory whose project is unavailable on this machine, so a new
      // generation never silently drops unresolved Memory.
      const composition = await planMemoryBackupComposition({
        stackHome: options.stackHome,
        nativeItems,
        registry: await readLocalRegistry(options.stackHome),
        ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
        ...(options.projects ? { projects: options.projects } : {}),
      });
      const result = await runMemoryBackup({
        stackHome: options.stackHome,
        items: nativeItems,
        carryForward: composition.carriedForward,
        ...(options.now ? { now: options.now } : {}),
      });
      // Phase 15B: resolve/mint stable Project IDs and refresh the portable
      // registry snapshot the next Cloud bundle will carry (paths never included).
      // Also persists this run's discovery-time name hints (machine-local only) and
      // retires any obsolete Local record whose vendor key now resolves to Git.
      await syncRegistryForBackup({
        stackHome: options.stackHome,
        nameHints,
        vendorKeys,
      });
      return result;
    },
    planRestore: async () =>
      planMemoryRestore({
        stackHome: options.stackHome,
        registry: await readLocalRegistry(options.stackHome),
        ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
        ...(options.projects ? { projects: options.projects } : {}),
      }),
    restore: async ({ apply }) =>
      runMemoryRestore({
        stackHome: options.stackHome,
        apply,
        registry: await readLocalRegistry(options.stackHome),
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
  previewBackup: async () => ({
    provider: 'claude',
    native: [],
    carriedForward: [],
    nativeFiles: 0,
    nativeProjects: 0,
    availableProjects: 0,
    retainedFiles: 0,
    retainedProjects: 0,
    retainedAvailableFiles: 0,
    retainedAvailableProjects: 0,
    retainedUnavailableFiles: 0,
    retainedUnavailableProjects: 0,
    finalFiles: 0,
    finalProjects: 0,
  }),
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

/**
 * Summarize the staged Memory, or null when nothing is staged at all. Since the
 * canonical migration the v1 manifest holds global Memory only and Project
 * Memory lives in canonical `main.json`, so both are counted: projects with at
 * least one present document, and present documents (tombstones are not
 * backed-up files), plus the v1 manifest's own items.
 */
export const readMemoryStatus = async (
  stackHome: string,
): Promise<MemoryStatus | null> => {
  const manifest = await readMemoryManifest(stackHome);
  const canonical = (await readCanonicalMain(stackHome)).projects
    .map((project) => ({
      projectId: project.projectId,
      present: project.documents.filter((doc) => doc.state === 'present').length,
    }))
    .filter((project) => project.present > 0);
  if (!manifest && canonical.length === 0) return null;
  const items = manifest?.items ?? [];
  const legacyProjects = items
    .filter((item) => item.scope === 'project' && item.project)
    .map((item) =>
      item.project?.kind === 'git'
        ? item.project.canonical
        : `local:${item.project?.kind === 'local' ? item.project.vendorKey : ''}`,
    );
  const projects = new Set([...legacyProjects, ...canonical.map((project) => project.projectId)]).size;
  return {
    provider: 'claude',
    projects,
    files: items.length + canonical.reduce((n, project) => n + project.present, 0),
    lastBackupAt: manifest?.createdAt ?? null,
  };
};
