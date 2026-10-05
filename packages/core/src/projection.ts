import { resolvedLocalEnvironmentSchema } from '@stack/spec';
import type { ResolvedLocalEnvironment } from '@stack/spec';

import { loadMainEnvironment } from './state.js';
import type { LoadedEnvironmentState } from './state.js';

/**
 * The set of Skills that project into agent directories, derived from the lock (P2). This is
 * the single source of truth for "what reaches the agents": PAUSED Skills are excluded here,
 * so every projection path — `stak run` and `stak skill update` — skips them without each
 * reimplementing the rule. Non-paused Skills are projected by their stable entryId, name and
 * approved immutable contentHash.
 */
export const projectedLocalEnvironment = (
  state: LoadedEnvironmentState,
): ResolvedLocalEnvironment =>
  resolvedLocalEnvironmentSchema.parse({
    name: state.manifest.name,
    machineId: state.machine.machineId,
    skills: Object.entries(state.lock.skills)
      .filter(([, locked]) => locked.paused !== true)
      .map(([entryId, locked]) => ({
        entryId,
        name: locked.name,
        contentHash: locked.contentHash,
      })),
  });

/** Load main and project it into the agent-facing environment (paused Skills excluded). */
export const loadProjectedLocalEnvironment = async (options: {
  stackHome: string;
}): Promise<ResolvedLocalEnvironment> =>
  projectedLocalEnvironment(
    await loadMainEnvironment({ stackHome: options.stackHome }),
  );
