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
