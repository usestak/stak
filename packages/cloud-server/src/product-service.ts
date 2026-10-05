import { computeEnvironmentBundleDigest } from '@stack/shared';
import type {
  ActivityItem,
  ActivityReadModel,
  ApproveSkillVersionRequest,
  CloudEnvironmentBundle,
  DeleteCloudMemoryResponse,
  MachinesReadModel,
  MemoryReadModel,
  NeedsAttention,
  OverviewReadModel,
  PortableLockedSkill,
  ProjectsReadModel,
  RevokeMachineResponse,
  SetSkillPausedRequest,
  SkillDetail,
  SkillInstall,
  SkillSourceSummary,
  SkillSummary,
  SkillUpdateStatus,
  SkillsReadModel,
  StacksReadModel,
  SyncProjectsRequest,
} from '@stack/spec';
import type { RemoteMemoryBackend } from '@stack/memory';

import { invalidRequest, notFound, remoteConflict } from './errors.js';
import { deriveMachineState } from './machine-state.js';
import { RemoteConflict } from './repository.js';
import type {
  CloudRepository,
  CloudEnvironmentVersionRecord,
  MachineStateRecord,
} from './repository.js';
import type { AuthenticatedUser } from './service.js';

const STALE_MACHINE_MS = 30 * 24 * 60 * 60 * 1000;

/** Source-latest result for one Skill (the P3 cloud layer injects a real resolver). */
export type SourceLatest =
  | { status: 'same' }
  | { status: 'different'; sourceRevision: string }
  | { status: 'uncheckable' };
export type SkillSourceChecker = (input: {
  skillId: string;
  restoration: PortableLockedSkill['restoration'];
}) => Promise<SourceLatest>;

/** Optional per-project file-count deriver (Standard Memory only; never decrypts Protected). */
export type MemoryProjectCounts = (
  userId: string,
) => Promise<{ projectId: string; fileCount: number }[] | null>;

export type ProductServiceConfig = {
  repository: CloudRepository;
  now: () => Date;
  newId: () => string;
  memoryBackendFor?: (userId: string) => RemoteMemoryBackend;
  /** Injected source-latest check; absent ⇒ every Skill is `cannot-check` (fail closed). */
  checkSkillSource?: SkillSourceChecker;
  /** Injected Standard per-project counts; absent ⇒ null (unavailable). */
  memoryProjectCounts?: MemoryProjectCounts;
};

const sourceSummaryOf = (skill: PortableLockedSkill): SkillSourceSummary => {
  if (skill.restoration.strategy === 'reference') {
    const ref = skill.restoration.reference;
    return {
      kind: 'git',
      checkable: ref.ref !== undefined,
      label: ref.remote,
      ...(ref.ref ? { trackedRef: ref.ref } : {}),
    };
  }
  return {
    kind: skill.restoration.reason === 'local' ? 'local' : 'snapshot',
    checkable: false,
  };
};

const capabilityStateOf = (skill: PortableLockedSkill) => {
  const declared = skill.metadata?.capabilities;
  return declared
    ? { declared: true as const, capabilities: declared }
    : { declared: false as const };
};

export const createProductMethods = (config: ProductServiceConfig) => {
  const nowIso = () => config.now().toISOString();
  const nowMs = () => config.now().getTime();
  const backendFor = (userId: string): RemoteMemoryBackend | null =>
    config.memoryBackendFor ? config.memoryBackendFor(userId) : null;

  /** The user's latest desired-state bundle (approved Skills), or null when nothing is pushed. */
  const latestBundle = async (
    userId: string,
  ): Promise<{
    version: CloudEnvironmentVersionRecord;
    bundle: CloudEnvironmentBundle;
  } | null> => {
    const environment = await config.repository.getEnvironmentByName(
      userId,
      'main',
    );
    if (!environment?.latestVersionId) return null;
    const version = await config.repository.getEnvironmentVersion(
      environment.latestVersionId,
    );
    if (!version || version.userId !== userId) return null;
    return { version, bundle: version.bundle };
  };

  /** Approved (non-paused) Skill versions for machine-state derivation. */
  const approvedList = (bundle: CloudEnvironmentBundle | null) =>
    bundle
      ? Object.entries(bundle.resolved.skills).map(([skillId, skill]) => ({
          skillId,
          approvedVersion: skill.contentHash,
          paused: skill.paused === true,
        }))
      : [];

  const factsOf = (machine: MachineStateRecord) => ({
    lastCheckinAt: machine.lastCheckinAt ?? null,
    memoryBackedUp: machine.memoryBackedUp ?? false,
    skills: machine.skills,
  });

  /** Assert the requested viewing machine belongs to the user; return it or fail safely. */
  const resolveViewingMachine = (
    machines: MachineStateRecord[],
    requested: string | undefined,
  ): MachineStateRecord | null => {
    if (!requested) return null;
    const match = machines.find((m) => m.machineId === requested);
    if (!match)
      throw notFound('machine-not-found', 'No such machine for this account.');
    return match;
  };

  const skillSummaries = async (userId: string): Promise<SkillSummary[]> => {
    const current = await latestBundle(userId);
    if (!current) return [];
    const machines = await config.repository.listMachineStates(userId);
    const installsBySkill = new Map<string, SkillInstall[]>();
    for (const machine of machines)
      for (const skill of machine.skills) {
        const list = installsBySkill.get(skill.skillId) ?? [];
        list.push({
          machineId: machine.machineId,
          ...(machine.name !== undefined ? { name: machine.name } : {}),
          installedVersion: skill.installedVersion,
        });
        installsBySkill.set(skill.skillId, list);
      }
    const result: SkillSummary[] = [];
    for (const [skillId, skill] of Object.entries(
      current.bundle.resolved.skills,
    )) {
      let updateStatus: SkillUpdateStatus = 'cannot-check';
      let candidateVersion: string | undefined;
      if (config.checkSkillSource) {
        const latest = await config.checkSkillSource({
          skillId,
          restoration: skill.restoration,
        });
        if (latest.status === 'same') updateStatus = 'no-update';
        else if (latest.status === 'different') {
          updateStatus = 'update-available';
          candidateVersion = latest.sourceRevision;
        } else updateStatus = 'cannot-check';
      }
      result.push({
        skillId,
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        approvedVersion: skill.contentHash,
        paused: skill.paused === true,
        source: sourceSummaryOf(skill),
        capability: capabilityStateOf(skill),
        updateStatus,
        ...(candidateVersion ? { candidateVersion } : {}),
        installs: installsBySkill.get(skillId) ?? [],
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  };

  return {
    /* ------------------------------ Skills ------------------------------ */
    getSkillsReadModel: async (
      user: AuthenticatedUser,
    ): Promise<SkillsReadModel> => ({
      environmentExists: (await latestBundle(user.userId)) !== null,
      skills: await skillSummaries(user.userId),
    }),

    getSkillDetail: async (
      user: AuthenticatedUser,
      skillId: string,
    ): Promise<SkillDetail> => {
      const summaries = await skillSummaries(user.userId);
      const summary = summaries.find((s) => s.skillId === skillId);
      if (!summary) throw notFound('skill-not-found', 'No such Skill.');
      // Version history: the approved contentHash across this env's immutable versions.
      const versions = await config.repository.listEnvironmentVersions(
        user.userId,
        'main',
      );
      const seen = new Set<string>();
      const history = versions
        .map((version) => ({
          contentHash: version.bundle.resolved.skills[skillId]?.contentHash,
          environmentVersionNumber: version.versionNumber,
          approvedAt: version.createdAt,
        }))
        .filter(
          (
            entry,
          ): entry is NonNullable<typeof entry> & { contentHash: string } =>
            entry.contentHash !== undefined,
        )
        .filter((entry) => {
          if (seen.has(entry.contentHash)) return false;
          seen.add(entry.contentHash);
          return true;
        });
      return { ...summary, history, files: null, diff: null };
    },

    approveSkillVersion: async (
      user: AuthenticatedUser,
      request: ApproveSkillVersionRequest,
    ) => {
      const current = await latestBundle(user.userId);
      if (!current)
        throw notFound('remote-environment-not-found', 'No cloud Environment.');
      const skill = current.bundle.resolved.skills[request.skillId];
      if (!skill) throw notFound('skill-not-found', 'No such Skill.');
      if (skill.restoration.strategy !== 'reference')
        throw invalidRequest(
          'This Skill has no checkable source to approve a version from.',
        );
      // Already at the reviewed candidate ⇒ idempotent no-op (not a stale error).
      if (skill.contentHash === request.candidateContentHash)
        return {
          skillId: request.skillId,
          approvedVersion: skill.contentHash,
          createdNew: false,
        };
      // Stale-review guard: the write must name the exact immutable candidate the user
      // reviewed. We apply THAT candidate, never silently a different current source.
      const nextSkill: PortableLockedSkill = {
        ...skill,
        contentHash: request.candidateContentHash,
        restoration: {
          strategy: 'reference',
          reference: {
            ...skill.restoration.reference,
            revision: request.candidateRevision,
            expectedContentHash: request.candidateContentHash,
          },
        },
      };
      const approvedVersion = await commitBundleMutation(user.userId, current, {
        [request.skillId]: nextSkill,
      });
      return {
        skillId: request.skillId,
        approvedVersion: request.candidateContentHash,
        createdNew: true,
        environmentVersionNumber: approvedVersion.versionNumber,
      };
    },

    setSkillPaused: async (
      user: AuthenticatedUser,
      request: SetSkillPausedRequest,
    ) => {
      const current = await latestBundle(user.userId);
      if (!current)
        throw notFound('remote-environment-not-found', 'No cloud Environment.');
      const skill = current.bundle.resolved.skills[request.skillId];
      if (!skill) throw notFound('skill-not-found', 'No such Skill.');
      if ((skill.paused === true) === request.paused)
        return {
          skillId: request.skillId,
          paused: request.paused,
          changed: false,
        };
      const nextSkill: PortableLockedSkill = { ...skill };
      if (request.paused) nextSkill.paused = true;
      else delete nextSkill.paused;
      const version = await commitBundleMutation(user.userId, current, {
        [request.skillId]: nextSkill,
      });
      return {
        skillId: request.skillId,
        paused: request.paused,
        changed: true,
        environmentVersionNumber: version.versionNumber,
      };
    },

    /* ----------------------------- Machines ----------------------------- */
    getMachinesReadModel: async (
      user: AuthenticatedUser,
    ): Promise<MachinesReadModel> => {
      const machines = await config.repository.listMachineStates(user.userId);
      const approved = approvedList(
        (await latestBundle(user.userId))?.bundle ?? null,
      );
      return {
        machines: machines.map((machine) => {
          const derived = deriveMachineState(factsOf(machine), approved);
          return {
            machineId: machine.machineId,
            ...(machine.name !== undefined ? { name: machine.name } : {}),
            ...(machine.platform !== undefined
              ? { platform: machine.platform }
              : {}),
            ...(machine.arch !== undefined ? { arch: machine.arch } : {}),
            agentsDetected: machine.agentsDetected ?? [],
            lastCheckinAt: machine.lastCheckinAt ?? null,
            memoryBackedUp: machine.memoryBackedUp ?? false,
            revoked: machine.revokedAt !== undefined,
            status: derived.status,
            updatesWaiting: derived.updatesWaiting,
            projectsPresent: machine.projects.filter((p) => p.present).length,
          };
        }),
      };
    },

    revokeMachine: async (
      user: AuthenticatedUser,
      machineId: string,
    ): Promise<RevokeMachineResponse> => {
      const result = await config.repository.revokeMachine(
        user.userId,
        machineId,
        nowIso(),
      );
      if (!result)
        throw notFound(
          'machine-not-found',
          'No such machine for this account.',
        );
      return { machineId, revoked: true };
    },

    /* ----------------------------- Projects ----------------------------- */
    getProjectsReadModel: async (
      user: AuthenticatedUser,
    ): Promise<ProjectsReadModel> => {
      const [registry, machines, counts] = await Promise.all([
        config.repository.listProjects(user.userId),
        config.repository.listMachineStates(user.userId),
        config.memoryProjectCounts
          ? config.memoryProjectCounts(user.userId)
          : Promise.resolve(null),
      ]);
      const presence = new Map<string, string[]>();
      for (const machine of machines)
        for (const project of machine.projects)
          if (project.present) {
            const list = presence.get(project.projectId) ?? [];
            list.push(machine.machineId);
            presence.set(project.projectId, list);
          }
      const countBy = new Map(
        (counts ?? []).map((c) => [c.projectId, c.fileCount]),
      );
      return {
        projects: registry.map((project) => ({
          projectId: project.projectId,
          ...(project.name !== undefined ? { name: project.name } : {}),
          lifecycle: project.lifecycle,
          presentOn: presence.get(project.projectId) ?? [],
          fileCount:
            counts === null ? null : (countBy.get(project.projectId) ?? 0),
          lastBackupAt: null,
        })),
      };
    },

    syncProjects: async (
      user: AuthenticatedUser,
      request: SyncProjectsRequest,
    ): Promise<{ ok: true }> => {
      await config.repository.syncProjects(
        user.userId,
        request.projects.map((project) => ({
          projectId: project.projectId,
          ...(project.name !== undefined ? { name: project.name } : {}),
        })),
        nowIso(),
      );
      return { ok: true };
    },

    setProjectLifecycle: async (
      user: AuthenticatedUser,
      projectId: string,
      lifecycle: 'active' | 'archived',
    ) => {
      const updated = await config.repository.setProjectLifecycle(
        user.userId,
        projectId,
        lifecycle,
        nowIso(),
      );
      if (!updated)
        throw notFound(
          'project-not-found',
          'No such project for this account.',
        );
      return { projectId, lifecycle: updated.lifecycle };
    },

    /* ------------------------------ Memory ------------------------------ */
    getMemoryReadModel: async (
      user: AuthenticatedUser,
    ): Promise<MemoryReadModel> => {
      const backend = backendFor(user.userId);
      if (!backend)
        return {
          mode: null,
          latestBackupAt: null,
          backups: [],
          recoveryMethods: [],
          hasRecoveryMethod: false,
          perProject: null,
        };
      const [profile, generations, methods] = await Promise.all([
        backend.getProfile(),
        backend.listGenerations(),
        backend.listRecoveryMethods(),
      ]);
      const mode = profile?.privacyMode ?? null;
      const sorted = [...generations].sort(
        (a, b) => b.generation - a.generation,
      );
      const perProject =
        mode === 'standard' && config.memoryProjectCounts
          ? await config.memoryProjectCounts(user.userId)
          : null;
      return {
        mode,
        latestBackupAt: sorted[0]?.createdAt ?? null,
        backups: sorted.map((g) => ({
          generation: g.generation,
          mode: g.privacyMode,
          createdAt: g.createdAt,
        })),
        recoveryMethods: methods.map((m) => ({
          type: m.type,
          label: m.label,
          createdAt: m.createdAt,
        })),
        hasRecoveryMethod: methods.length > 0,
        perProject,
      };
    },

    /**
     * Narrow destructive action (P0/addendum): remove ALL Cloud-held Memory recovery data —
     * every backup generation and every recovery method — so the user has no recoverable Cloud
     * Memory. Never touches Skills, Projects, machines, environments, or local/native Memory.
     */
    deleteCloudMemory: async (
      user: AuthenticatedUser,
    ): Promise<DeleteCloudMemoryResponse> => {
      const backend = backendFor(user.userId);
      if (!backend)
        return {
          deletedGenerations: 0,
          deletedRecoveryMethods: 0,
          recoverable: false,
        };
      const [generations, methods] = await Promise.all([
        backend.listGenerations(),
        backend.listRecoveryMethods(),
      ]);
      for (const generation of generations)
        await backend.retireGeneration(generation.backupId, config.now);
      for (const method of methods)
        await backend.revokeRecoveryMethod(method.methodId, config.now);
      return {
        deletedGenerations: generations.length,
        deletedRecoveryMethods: methods.length,
        recoverable: false,
      };
    },

    /* ------------------------------ Stacks ------------------------------ */
    getStacksReadModel: async (
      user: AuthenticatedUser,
    ): Promise<StacksReadModel> => {
      const environment = await config.repository.getEnvironmentByName(
        user.userId,
        'main',
      );
      if (!environment) return { owned: [] };
      const current = await latestBundle(user.userId);
      return {
        owned: [
          {
            name: environment.name,
            environmentId: environment.environmentId,
            latestVersionNumber: current?.version.versionNumber ?? null,
            skillCount: current
              ? Object.keys(current.bundle.resolved.skills).length
              : 0,
            updatedAt: current?.version.createdAt ?? null,
          },
        ],
      };
    },

    /* ----------------------------- Activity ----------------------------- */
    getActivityReadModel: async (
      user: AuthenticatedUser,
    ): Promise<ActivityReadModel> => ({
      items: await deriveActivity(user.userId),
    }),

    /* ----------------------------- Overview ----------------------------- */
    getOverview: async (
      user: AuthenticatedUser,
      viewingMachineId?: string,
    ): Promise<OverviewReadModel> => {
      const [skills, machines, projects, memory, activity, current] =
        await Promise.all([
          skillSummaries(user.userId),
          config.repository.listMachineStates(user.userId),
          config.repository.listProjects(user.userId),
          (async () => {
            const backend = backendFor(user.userId);
            if (!backend) return { mode: null, hasRecovery: false };
            const [profile, methods] = await Promise.all([
              backend.getProfile(),
              backend.listRecoveryMethods(),
            ]);
            return {
              mode: profile?.privacyMode ?? null,
              hasRecovery: methods.length > 0,
            };
          })(),
          deriveActivity(user.userId),
          latestBundle(user.userId),
        ]);
      const viewing = resolveViewingMachine(machines, viewingMachineId);
      const approved = approvedList(current?.bundle ?? null);
      const machineStates = machines.map((m) => ({
        machine: m,
        derived: deriveMachineState(factsOf(m), approved),
      }));
      const needsAttention: NeedsAttention[] = [];
      for (const skill of skills)
        if (skill.updateStatus === 'update-available')
          needsAttention.push({
            kind: 'update-available',
            label: `Update available for ${skill.name}`,
            ref: skill.skillId,
          });
      // Project not present on the viewing machine (only a truthful per-machine condition).
      if (viewing) {
        const presentIds = new Set(
          viewing.projects.filter((p) => p.present).map((p) => p.projectId),
        );
        for (const project of projects)
          if (
            project.lifecycle === 'active' &&
            !presentIds.has(project.projectId)
          )
            needsAttention.push({
              kind: 'project-not-on-machine',
              label: `${project.name ?? project.projectId} is not on this machine`,
              ref: project.projectId,
            });
      }
      for (const { machine } of machineStates)
        if (
          machine.lastCheckinAt &&
          nowMs() - new Date(machine.lastCheckinAt).getTime() >=
            STALE_MACHINE_MS
        )
          needsAttention.push({
            kind: 'machine-stale',
            label: `${machine.name ?? 'A machine'} hasn't checked in for 30+ days`,
            ref: machine.machineId,
          });
      if (memory.mode === 'protected' && !memory.hasRecovery)
        needsAttention.push({
          kind: 'protected-no-recovery',
          label: 'Protected Memory has no recovery method',
        });
      return {
        viewingMachineId: viewing?.machineId ?? null,
        lastBackupAt:
          activity.find((a) => a.kind === 'memory-backed-up')?.at ?? null,
        skills: {
          total: skills.length,
          paused: skills.filter((s) => s.paused).length,
          updatesAvailable: skills.filter(
            (s) => s.updateStatus === 'update-available',
          ).length,
        },
        memory: { mode: memory.mode, hasRecoveryMethod: memory.hasRecovery },
        projects: {
          total: projects.length,
          archived: projects.filter((p) => p.lifecycle === 'archived').length,
        },
        machines: {
          total: machines.length,
          updatesWaiting: machineStates.filter(
            (m) => m.derived.status === 'updates-waiting',
          ).length,
        },
        needsAttention,
        recentActivity: activity.slice(0, 20),
      };
    },
  };

  /** Mutate specific Skills in the latest bundle and commit a new immutable version. */
  async function commitBundleMutation(
    userId: string,
    current: {
      version: CloudEnvironmentVersionRecord;
      bundle: CloudEnvironmentBundle;
    },
    changed: Record<string, PortableLockedSkill>,
  ): Promise<CloudEnvironmentVersionRecord> {
    const skills = { ...current.bundle.resolved.skills, ...changed };
    const resolved = { schemaVersion: 1 as const, skills };
    const digest = computeEnvironmentBundleDigest({
      environment: current.bundle.environment,
      resolved,
      importedStackVersions: current.bundle.importedStackVersions,
    });
    const nextBundle: CloudEnvironmentBundle = {
      ...current.bundle,
      resolved,
      digest,
    };
    try {
      const outcome = await config.repository.commitEnvironmentVersion({
        userId,
        name: current.bundle.environment.name,
        bundle: nextBundle,
        digest,
        expectedLatestVersionId: current.version.versionId,
        ids: {
          environmentId: current.version.environmentId,
          versionId: config.newId(),
        },
        now: nowIso(),
      });
      return outcome.version;
    } catch (error) {
      if (error instanceof RemoteConflict)
        throw remoteConflict(
          'The Environment changed since you reviewed it; reload and try again.',
        );
      throw error;
    }
  }

  /** Derive recent activity from truthful persisted timestamps only (no events table). */
  async function deriveActivity(userId: string): Promise<ActivityItem[]> {
    const items: ActivityItem[] = [];
    const backend = backendFor(userId);
    if (backend)
      for (const generation of await backend.listGenerations())
        items.push({
          kind: 'memory-backed-up',
          at: generation.createdAt,
          sourceId: generation.backupId,
          label: `Memory backup #${generation.generation}`,
        });
    for (const machine of await config.repository.listMachineStates(userId))
      if (machine.lastCheckinAt)
        items.push({
          kind: 'machine-checked-in',
          at: machine.lastCheckinAt,
          sourceId: machine.machineId,
          ...(machine.name ? { label: `${machine.name} checked in` } : {}),
        });
    return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }
};
