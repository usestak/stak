import os from 'node:os';

import {
  AuthenticationExpiredError,
  CloudUnauthorizedError,
  NotAuthenticatedError,
  type CloudClient,
} from '@stack/cloud-client';
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

/** Leaf command names whose success materially changes this machine's reported state. */
export const CHECKIN_COMMANDS: ReadonlySet<string> = new Set([
  'login',
  'status',
  'scan',
  'use',
  'run',
  'backup',
  'recover',
  'restore',
  'map',
]);
