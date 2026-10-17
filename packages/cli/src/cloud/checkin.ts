import os from 'node:os';

import {
  AuthenticationExpiredError,
  CloudUnauthorizedError,
  NotAuthenticatedError,
  type CloudClient,
} from '@stack/cloud-client';
import { safeDirectoryBasename } from '@stack/memory';
import type { MachineCheckinRequest } from '@stack/spec';

/**
 * Machine check-in (Phase P1). STAK has no daemon: the CLI reports this machine's state
 * best-effort during user-run operations. The payload is PRESENCE ONLY — project entries
 * are `{ projectId, present }`, never a path (absolute or home-relative) — and never
 * carries Memory content. Skills are reported as `{ skillId: <name>, installedVersion:
 * <content hash> }`: a name and a content hash, both path-free.
 */
export type CheckinSkill = { skillId: string; installedVersion: string };
export type CheckinProject = { projectId: string; present: boolean };

export type CheckinInputs = {
  machineId: string;
  name?: string;
  platform?: string;
  arch?: string;
  agentsDetected: string[];
  memoryBackedUp: boolean;
  skills: CheckinSkill[];
  projects: CheckinProject[];
};

/**
 * Map gathered inputs to the wire payload. By construction it carries only ids, a content
 * hash, booleans and OS strings — never a filesystem path and never Memory content. The
 * no-leak test asserts this on the output.
 */
export const buildCheckinPayload = (
  input: CheckinInputs,
): MachineCheckinRequest => ({
  machineId: input.machineId,
  memoryBackedUp: input.memoryBackedUp,
  agentsDetected: input.agentsDetected,
  skills: input.skills.map((s) => ({
    skillId: s.skillId,
    installedVersion: s.installedVersion,
  })),
  projects: input.projects.map((p) => ({
    projectId: p.projectId,
    present: p.present,
  })),
  ...(input.name ? { name: input.name } : {}),
  ...(input.platform ? { platform: input.platform } : {}),
  ...(input.arch ? { arch: input.arch } : {}),
});

/**
 * An explicit authentication/authorization failure (401/403). These must NOT be treated
 * as "offline" — a revoked or invalid machine must never look successfully checked in.
 */
export const isAuthFailure = (error: unknown): boolean =>
  error instanceof NotAuthenticatedError ||
  error instanceof AuthenticationExpiredError ||
  error instanceof CloudUnauthorizedError;

export type CheckinResult = { status: 'ok' | 'skipped' };

/**
 * Report a check-in best-effort. Connectivity / unavailability / unexpected failures are
 * swallowed (non-fatal) so the parent command still succeeds offline. Authentication /
 * authorization failures (401/403) are re-thrown so the caller surfaces them explicitly.
 */
export const reportCheckin = async (deps: {
  client: Pick<CloudClient, 'machineCheckin'>;
  inputs: CheckinInputs;
}): Promise<CheckinResult> => {
  try {
    await deps.client.machineCheckin(buildCheckinPayload(deps.inputs));
    return { status: 'ok' };
  } catch (error) {
    if (isAuthFailure(error)) throw error;
    return { status: 'skipped' };
  }
};

const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

export type GatherCheckinDeps = {
  machine: () => Promise<{ machineId: string; platform: string; arch: string }>;
  hostname?: () => string;
  memoryBackedUp: () => Promise<boolean>;
  installedSkills: () => Promise<CheckinSkill[]>;
  projectPresence: () => Promise<CheckinProject[]>;
  agentsDetected: () => Promise<string[]>;
};

/**
 * Assemble the check-in inputs from local state. Every reader is best-effort: a failure in
 * any one (e.g. no environment yet) yields an empty section, never a thrown error, so a
 * check-in never breaks the command that triggered it.
 */
export const gatherCheckinInputs = async (
  deps: GatherCheckinDeps,
): Promise<CheckinInputs> => {
  const machine = await deps.machine();
  const [memoryBackedUp, skills, projects, agentsDetected] = await Promise.all([
    safe(deps.memoryBackedUp, false),
    safe(deps.installedSkills, [] as CheckinSkill[]),
    safe(deps.projectPresence, [] as CheckinProject[]),
    safe(deps.agentsDetected, [] as string[]),
  ]);
  return {
    machineId: machine.machineId,
    platform: machine.platform,
    arch: machine.arch,
    name: (deps.hostname ?? os.hostname)(),
    agentsDetected,
    memoryBackedUp,
    skills,
    projects,
  };
};

/**
 * Installed-skill identity (P1 review #2). Key by the STABLE entry id (`skill_…`) — never a
 * display name — so machine-installed state joins to the desired Skill record in P2/P3 and
 * two skills that share a display name but have distinct ids cannot collapse. The installed
 * version is the content ACTUALLY on this machine: `desiredHash` when satisfied (current ==
 * desired), `currentHash` when modified. A skill that is missing/uncertain is not installed
 * and is omitted.
 */
export type SkillStatusLike = {
  entryId: string;
  state: 'satisfied' | 'modified' | 'missing' | 'uncertain';
  desiredHash: string;
  currentHash?: string | undefined;
};
export const installedSkillsFrom = (
  statuses: SkillStatusLike[],
): CheckinSkill[] =>
  statuses.flatMap((s) => {
    const installedVersion =
      s.state === 'satisfied'
        ? s.desiredHash
        : s.state === 'modified'
          ? s.currentHash
          : undefined;
    return installedVersion ? [{ skillId: s.entryId, installedVersion }] : [];
  });

/**
 * Project presence (P1 review #1). TRUE availability from the Phase 15 resolver — a binding
 * OR a canonical-Git match — not merely "a binding record exists". No path is reported.
 */
export type ProjectRowLike = {
  projectId: string;
  availability: 'present' | 'unavailable';
};
export const projectPresenceFrom = (rows: ProjectRowLike[]): CheckinProject[] =>
  rows.map((r) => ({
    projectId: r.projectId,
    present: r.availability === 'present',
  }));

/**
 * A Cloud-safe display name for a Local project: just the final path segment (e.g. `swft`
 * from `C:\Users\NT\Desktop\swft`), never the path itself. `path.basename` cannot return a
 * string containing a path separator, so this can never smuggle a directory structure; the
 * explicit separator check below is defense in depth against a future caller passing
 * something other than a real directory. Returns `undefined` (no name sent — the fallback
 * `Local project · <id>` label stays in effect) when no safe basename can be determined.
 */
export const localProjectDisplayName = (
  dir: string | null | undefined,
): string | undefined => safeDirectoryBasename(dir);

/**
 * Discovery-sync payload for the cloud project registry (P3). The safe display `name` comes
 * from either: a STRONG Git identity (its canonical `host/owner/repo`, which is account
 * metadata, not a path), or — for a Local project with a machine-local binding on THIS
 * machine — the bound directory's basename only (never the path itself, never the
 * path-derived vendor key). A Local project with no binding sends no name. No lifecycle is
 * sent: discovery never conveys lifecycle intent.
 */
export type ProjectSyncRowLike = {
  projectId: string;
  // The local variant's `vendorKey` is optional because the `stak project` list view already
  // strips it (it is path-derived); even if present, it is NEVER forwarded as a name.
  identity:
    { kind: 'git'; canonical: string } | { kind: 'local'; vendorKey?: string };
  // Machine-local absolute directory this project is bound to, if any. NEVER forwarded
  // as-is — only its basename (via `localProjectDisplayName`) may be sent.
  binding?: string | null;
  // Machine-local discovery-time basename hint (see `@stack/memory`'s `nameHintFor`),
  // never a full path. Takes precedence over `binding`'s basename — a project's
  // discovery-time name should not flip just because its current mapping points
  // somewhere with a different folder name.
  discoveredName?: string | null;
};
export const projectSyncPayloadFrom = (
  rows: ProjectSyncRowLike[],
): { projectId: string; name?: string; gitCanonical?: string }[] =>
  rows.map((row) => {
    if (row.identity.kind === 'git')
      return {
        projectId: row.projectId,
        name: row.identity.canonical,
        // Carried explicitly so Cloud-side reconciliation matches on the actual
        // canonical identity, never by sniffing the `name` string.
        gitCanonical: row.identity.canonical,
      };
    const name = row.discoveredName || localProjectDisplayName(row.binding);
    return name
      ? { projectId: row.projectId, name }
      : { projectId: row.projectId };
  });

/**
 * Memory backed-up truth (P1 review #3). TRUE only when every current native Memory item is
 * present and byte-identical (by content hash) in the latest backup manifest — so a native
 * file that changed or was added since the last backup yields FALSE. No manifest ⇒ FALSE.
 * Conservative by design: a false negative is safer than a false "Up to date". Reads only
 * logical ids and content hashes — never Memory content, never a path.
 */
export type MemoryItemLike = { logicalId: string; contentHash: string };
export const nativeMemoryBackedUp = (
  nativeItems: MemoryItemLike[],
  manifestItems: MemoryItemLike[] | null,
): boolean => {
  if (manifestItems === null) return false;
  const backed = new Map(
    manifestItems.map((i) => [i.logicalId, i.contentHash]),
  );
  return nativeItems.every((i) => backed.get(i.logicalId) === i.contentHash);
};

/**
 * Leaf command names whose success materially changes this machine's reported state
 * (P1 review #4). Included are commands that change installed skills, project presence,
 * memory-backed-up, OR the machine's reported inventory (detected agents). Excluded are
 * commands that change account-side desired state (use/push/pull), lifecycle
 * (archive/unarchive), and sign-out.
 *
 * `scan` is included: although it does not mutate agent projection, it refreshes the
 * machine's reported inventory (`agentsDetected`). The 0.1.0 onboarding contract (P8)
 * derives "Agents found: …" from real check-in records, so a successful scan must publish
 * the machine's detected agents. `use` remains excluded — it changes account-side desired
 * state, not installed machine state.
 */
export const CHECKIN_COMMANDS: ReadonlySet<string> = new Set([
  'login', // registers the machine; first check-in
  'status', // the explicit check-in
  'scan', // refreshes reported inventory (agentsDetected) for onboarding
  'run', // projects main into agent dirs → installed skills change
  'update', // `stak skill update` installs approved versions → installed skills change
  'backup', // native Memory now matches the latest backup
  'recover', // local store/registry reconciled → presence + memory-backed-up
  'restore', // writes native agent Memory → memory-backed-up
  'map', // binding added → project presence changes
]);
