/**
 * Shared Project presentation logic — the Projects-list, Projects-detail, and Memory per-project
 * table all derive the CLI selector and presence/lifecycle labels from here, so they can never
 * drift apart (the same reason `lib/skill-presentation.ts` exists for Skills).
 */

/** The CLI selector a human should be shown for `stak project map`/`archive`/`unarchive`: the
 *  display name when it is unique across every Project the viewer can see, the stable `prj_...`
 *  id otherwise. Mirrors `cliSkillSelector` in `lib/skill-presentation.ts`. */
export const cliProjectSelector = (
  projectId: string,
  name: string | undefined,
  allProjects: readonly { projectId: string; name?: string }[],
): string => {
  if (!name) return projectId;
  const matches = allProjects.filter((p) => p.name === name);
  return matches.length === 1 ? name : projectId;
};

/** Shortened `prj_...` id for display — never the full 28-char identifier as primary text. */
export const shortProjectId = (projectId: string): string =>
  projectId.length <= 12
    ? projectId
    : `${projectId.slice(0, 8)}…${projectId.slice(-4)}`;

/** A Git-backed `name` is a canonical `host/owner/repo` string (see `checkin.ts`'s
 *  `projectSyncPayloadFrom`). This pulls just the repo segment for a shorter,
 *  still-unambiguous-in-isolation label. */
const gitRepoSegment = (canonical: string): string => {
  const parts = canonical.split('/');
  return parts[parts.length - 1] || canonical;
};

/**
 * Whether a `name` was sent as a Git canonical identity rather than a Local basename.
 * A Git canonical is always `host/owner/repo` (at least two `/`s); a basename — the only
 * other form `projectSyncPayloadFrom` ever sends — can never contain a `/` on any
 * filesystem. This string-shape check is therefore a reliable, migration-free way to tell
 * the two apart from the single shared `name` column.
 */
const isGitCanonicalName = (name: string): boolean => name.includes('/');

/** Short, stable discriminator derived from `projectId` (never mutates identity) used to
 *  disambiguate two Projects that would otherwise render with the same short label. */
const discriminator = (projectId: string): string =>
  projectId.slice(-4).toUpperCase();

/**
 * Human-readable Project display name, without ever changing `projectId` (the authoritative
 * identifier) and without fabricating a name the server never had.
 *
 * - Git-backed (`name` is a `host/owner/repo` canonical string): show just the repo segment,
 *   e.g. `github.com/usestak/stak` -> `stak` — UNLESS another Project visible to this viewer
 *   would derive the same short segment, in which case fall back to the full canonical string
 *   so the two remain distinguishable (never silently merge two different repos).
 * - Local, with a safe basename (`name` present, no `/` — see `checkin.ts`'s
 *   `localProjectDisplayName`, which only ever sends the final path segment of a directory
 *   bound on this machine, never the path itself): show the basename directly, e.g. `swft` —
 *   UNLESS another visible Local Project shares the same basename, in which case append a
 *   short stable discriminator derived from `projectId`, e.g. `app · A81F`, so two same-named
 *   local folders stay distinguishable without ever touching identity.
 * - Local, no name at all (no binding has been reported from any machine yet, or a pre-upgrade
 *   CLI never sent one): there is no safe human name to show. Rather than exposing the raw
 *   28-char `prj_...` id as if it were meaningful content, label it honestly as a Local project
 *   with a short id suffix. This is a fallback-only path.
 */
export const projectDisplayName = (
  project: { projectId: string; name?: string },
  allProjects: readonly { projectId: string; name?: string }[],
): string => {
  if (!project.name)
    return `Local project · ${shortProjectId(project.projectId)}`;

  if (isGitCanonicalName(project.name)) {
    const short = gitRepoSegment(project.name);
    const collides = allProjects.some(
      (p) =>
        p.projectId !== project.projectId &&
        p.name &&
        isGitCanonicalName(p.name) &&
        gitRepoSegment(p.name) === short,
    );
    return collides ? project.name : short;
  }

  // Local basename.
  const collides = allProjects.some(
    (p) =>
      p.projectId !== project.projectId &&
      p.name &&
      !isGitCanonicalName(p.name) &&
      p.name === project.name,
  );
  return collides
    ? `${project.name} · ${discriminator(project.projectId)}`
    : project.name;
};

/** Frozen Project presence vocabulary (contract §10/§15) — never "Online"/"Offline"/"Lost". */
export const presenceLabel = (
  presentOn: readonly string[],
  viewingMachineId: string,
): 'On this machine' | 'Not on this machine' =>
  presentOn.includes(viewingMachineId)
    ? 'On this machine'
    : 'Not on this machine';

/** Frozen Project lifecycle vocabulary (contract §10). */
export const lifecycleLabel = (
  lifecycle: 'active' | 'archived',
): 'Active' | 'Archived' => (lifecycle === 'active' ? 'Active' : 'Archived');
