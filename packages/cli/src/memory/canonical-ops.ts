import {
  readLocalRegistry,
  type DiscoveredMemoryItem,
  type LocalRegistry,
  type ManifestItem,
} from '@stack/memory';

import { resolveCanonicalProjectId } from './canonical-identity.js';

export type BoundProjectRecord = { projectId: string; dir: string };

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
