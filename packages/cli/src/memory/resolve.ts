import path from 'node:path';

import type { ClaudeProjectInput } from '@stack/memory';

/**
 * Injectable environment for resolving which local project directories back the
 * Claude auto-memory folders. Kept dependency-light so the exact production
 * orchestration can be exercised in tests.
 */
export type MemoryProjectResolverDeps = {
  cwd: string;
  platform: NodeJS.Platform;
  /** Immediate child directory names of `dir` (empty on any error). */
  listDirs(dir: string): Promise<string[]>;
  /** `remote.origin.url` for a repo at `dir`, or undefined when none/not a repo. */
  gitOrigin(dir: string): Promise<string | undefined>;
};

/**
 * Resolve candidate local project directories for memory identity matching.
 *
 * The real dogfood topology is sibling checkouts (e.g. `Desktop/stack` and
 * `Desktop/atlas-access-flow`), so candidates are the current working directory
 * plus its immediate siblings — a single, bounded parent-directory listing (never
 * a whole-disk scan, never hardcoded roots). Each candidate's Git origin (if any)
 * is attached; the memory adapter then matches each candidate against the
 * authoritative Claude auto-memory folders by encoded vendor key and keeps
 * anything unmatched or origin-less as `local:<key>`.
 *
 * Path math uses the platform's semantics (win32 vs posix) so Windows candidate
 * paths encode to the same vendor keys Claude produced, independent of the host
 * running the resolver.
 */
export const resolveMemoryProjects = async (
  deps: MemoryProjectResolverDeps,
): Promise<ClaudeProjectInput[]> => {
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  const parent = p.dirname(deps.cwd);
  const candidateDirs = new Set<string>([deps.cwd]);
  for (const name of await deps.listDirs(parent))
    candidateDirs.add(p.join(parent, name));

  const projects: ClaudeProjectInput[] = [];
  for (const dir of candidateDirs) {
    const gitRemote = await deps.gitOrigin(dir);
    projects.push(gitRemote ? { dir, gitRemote } : { dir });
  }
  return projects;
};
