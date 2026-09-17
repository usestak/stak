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
