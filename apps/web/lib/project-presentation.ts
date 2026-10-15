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

/** A Git-backed `name` is a canonical `host/owner/repo` string (the ONLY form ever sent to
 *  Cloud for a Project — see `checkin.ts`'s `projectSyncPayloadFrom`, which deliberately never
 *  forwards a Local project's path-derived identity for privacy). This pulls just the repo
 *  segment for a shorter, still-unambiguous-in-isolation label. */
const gitRepoSegment = (canonical: string): string => {
  const parts = canonical.split('/');
  return parts[parts.length - 1] || canonical;
};

/**
 * Human-readable Project display name, without ever changing `projectId` (the authoritative
 * identifier) and without fabricating a name the server never had.
 *
 * - Git-backed (`name` present, a `host/owner/repo` canonical string): show just the repo
 *   segment, e.g. `github.com/usestak/stak` -> `stak` — UNLESS another Project visible to this
 *   viewer would derive the same short segment, in which case fall back to the full canonical
 *   string so the two remain distinguishable (never silently merge two different repos).
 * - Local (`name` absent — by design; Local identity is path-derived and never leaves the
 *   CLI/machine, see `checkin.ts`): there is no safe human name to show. Rather than exposing
 *   the raw 28-char `prj_...` id as if it were meaningful content, label it honestly as a
 *   Local project with a short id suffix. Sending a basename (e.g. just `nexus` from
 *   `C:\...\nexus`) to Cloud would be a real, deliberate privacy-boundary change this helper
 *   does not make unilaterally — flagged separately, not implemented here.
 */
export const projectDisplayName = (
  project: { projectId: string; name?: string },
  allProjects: readonly { projectId: string; name?: string }[],
): string => {
  if (!project.name)
    return `Local project · ${shortProjectId(project.projectId)}`;
  const short = gitRepoSegment(project.name);
  const collides = allProjects.some(
    (p) =>
      p.projectId !== project.projectId &&
      p.name &&
      gitRepoSegment(p.name) === short,
  );
  return collides ? project.name : short;
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
