import os from 'node:os';
import path from 'node:path';

import type { SkillRoot, SkillRootKind } from '@stack/spec';

export type ResolveScanRootsOptions = {
  homeDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  includeProject?: boolean;
};
const rootKinds: SkillRootKind[] = ['agents', 'cursor', 'claude', 'codex'];

/**
 * Vendor-reserved subtrees that live immediately under an agent's Skill root.
 * These are created and managed by the agent/vendor — not by Stack — so they must
 * be excluded from Skill discovery and never become Stack-owned direct Skills.
 *
 * Only the reserved directory *immediately* under the Skill root is excluded; a
 * directory that merely shares one of these names deeper inside an ordinary Skill
 * is left untouched. Comparison is case-insensitive because vendors reserve these
 * names regardless of capitalization.
 */
const reservedRootSubtrees: Partial<Record<SkillRootKind, readonly string[]>> =
  {
    // Codex bundles its own system Skills (e.g. skill-creator) under `.system`.
    codex: ['.system'],
    // Claude Code stores account-synced Skills downloaded from claude.ai under
    // `synced`, and inactive/recoverable copies of disabled synced Skills under
    // `.trash`. Both are managed by Claude and are not Stack inputs.
    claude: ['synced', '.trash'],
  };

/**
 * Whether `name`, an immediate child of a `rootKind` Skill root, is a
 * vendor-reserved subtree that must be excluded from Skill discovery.
 */
export const isReservedRootSubtree = (
  rootKind: SkillRootKind,
  name: string,
): boolean =>
  (reservedRootSubtrees[rootKind] ?? []).some(
    (reserved) => reserved.toLowerCase() === name.toLowerCase(),
  );

export const resolveScanRoots = (
  options: ResolveScanRootsOptions = {},
): SkillRoot[] => {
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const roots: SkillRoot[] = [
    {
      path: path.join(homeDir, '.agents', 'skills'),
      rootKind: 'agents',
      scope: 'global',
    },
    {
      path: path.join(homeDir, '.cursor', 'skills'),
      rootKind: 'cursor',
      scope: 'global',
    },
    {
      path: path.join(homeDir, '.claude', 'skills'),
      rootKind: 'claude',
      scope: 'global',
    },
    {
      path: path.join(env.CODEX_HOME || path.join(homeDir, '.codex'), 'skills'),
      rootKind: 'codex',
      scope: 'global',
    },
  ];
  if (!options.includeProject) return roots;
  return roots.concat(
    rootKinds.map((rootKind) => ({
      path: path.join(cwd, `.${rootKind}`, 'skills'),
      rootKind,
      scope: 'project' as const,
    })),
  );
};
