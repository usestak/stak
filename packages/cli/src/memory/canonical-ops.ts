import {
  applyImportActions,
  migrateLocalStore,
  planProjectSync,
  readLocalRegistry,
  scanClaudeProject,
  type DiscoveredMemoryItem,
  type LocalRegistry,
  type ManifestItem,
  type ScanResult,
} from '@stack/memory';

import { resolveCanonicalProjectId } from './canonical-identity.js';

export type BoundProjectRecord = { projectId: string; dir: string };

export type CanonicalProjectSummary = {
  projectId: string;
  imported: string[];
  conflicts: { path: string; reason: string }[];
  sourceConflicts: string[];
  guardedPaths: string[];
};

const planAllBoundProjects = async (
  stackHome: string,
  options: { claudeHome?: string } = {},
): Promise<Array<{ projectId: string; dir: string; plan: Awaited<ReturnType<typeof planProjectSync>>; scanResult: ScanResult }>> => {
  const bound = await listBoundProjects(stackHome);
  const registry = await readLocalRegistry(stackHome);
  const out = [];
  for (const { projectId, dir } of bound) {
    const scanOptions = {
      ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
      projects: [{ dir }],
      resolveProjectId: (item: DiscoveredMemoryItem) => resolveProjectIdForClaudeItem(item, registry),
    };
    const plan = await planProjectSync({ projectId, dir }, stackHome, scanOptions);
    const scanResult = await scanClaudeProject({ projectId, dir }, scanOptions);
    out.push({ projectId, dir, plan, scanResult });
  }
  return out;
};

const toSummary = (entry: Awaited<ReturnType<typeof planAllBoundProjects>>[number], imported: string[]): CanonicalProjectSummary => ({
  projectId: entry.projectId,
  imported,
  conflicts: entry.plan.actions
    .filter((a): a is Extract<typeof a, { kind: 'conflict' }> => a.kind === 'conflict')
    .map((a) => ({ path: a.path, reason: a.reason })),
  sourceConflicts: entry.plan.sourceConflicts.map((c) => c.canonicalPath),
  guardedPaths: entry.plan.guardedPaths,
});

/** Read-only: plans every bound project's sync but never imports. */
export const canonicalMemoryStatus = async (
  stackHome: string,
  options: { claudeHome?: string } = {},
): Promise<CanonicalProjectSummary[]> => {
  const entries = await planAllBoundProjects(stackHome, options);
  return entries.map((entry) => toSummary(entry, []));
};

/** `stak add .`'s canonical-Memory half: migrate once, then import every bound
 * project's native edits into canonical Memory. */
export const stageCanonicalMemory = async (
  stackHome: string,
  options: { claudeHome?: string } = {},
): Promise<CanonicalProjectSummary[]> => {
  await migrateLocalStore(stackHome);
  const entries = await planAllBoundProjects(stackHome, options);
  const summaries: CanonicalProjectSummary[] = [];
  for (const entry of entries) {
    const { imported } = await applyImportActions({ projectId: entry.projectId, dir: entry.dir }, stackHome, entry.scanResult, entry.plan.actions);
    summaries.push(toSummary(entry, imported));
  }
  return summaries;
};

/** Every machine-local binding this registry knows, regardless of lifecycle —
 * archived projects still sync their Memory (spec: "preserved regardless of
 * lifecycle"). */
export const listBoundProjects = async (stackHome: string): Promise<BoundProjectRecord[]> => {
  const registry = await readLocalRegistry(stackHome);
  return registry.bindings.map((binding) => ({ projectId: binding.projectId, dir: binding.dir }));
};

/** The `resolveProjectId` callback the canonical scan/migration functions expect,
 * wired to this CLI's already-proven identity resolution (`canonical-identity.ts`,
 * unchanged by this feature) so `@stack/memory` itself never depends on it. */
export const resolveProjectIdForClaudeItem = (
  item: Pick<DiscoveredMemoryItem | ManifestItem, 'project' | 'kind' | 'logicalId' | 'restoreTarget'>,
  registry: LocalRegistry,
): string | undefined => resolveCanonicalProjectId(item, registry);
