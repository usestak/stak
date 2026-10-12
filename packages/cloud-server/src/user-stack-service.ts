import { sha256CanonicalJson } from '@stack/shared';
import {
  assessSkillShareEligibility,
  type CreateUserStackRequest,
  type CreateUserStackResponse,
  type GetUserStackResponse,
  type ListUserStacksResponse,
  type PortableLockedSkill,
  type PublicStackBundle,
  type PublicStackRequirement,
  type PublishPublicStackVersionResponse,
  type PublishUserStackRequest,
  type UpdateUserStackRequest,
  type UpdateUserStackResponse,
  type UserStackBundle,
  type UserStackDetail,
  type UserStackSkill,
} from '@stack/spec';

import { notFound, publicationNotEligible } from './errors.js';
import {
  UserStackConflict,
  UserStackNameConflict,
  type CloudRepository,
  type UserStackRepository,
  type UserStackRecord,
  type UserStackVersionRecord,
} from './repository.js';
import type { AuthenticatedUser } from './service.js';

export type UserStackServiceContext = {
  repository: CloudRepository & UserStackRepository;
  newId: () => string;
  nowIso: () => string;
  resolveHandle: (userId: string) => Promise<string>;
  publishPublicStackVersion: (
    user: AuthenticatedUser,
    request: {
      slug: string;
      displayName?: string;
      description?: string;
      bundle: PublicStackBundle;
      expectedLatestVersionId: string | null;
    },
  ) => Promise<PublishPublicStackVersionResponse>;
};

const versionSummary = (version: UserStackVersionRecord) => ({
  versionId: version.versionId,
  versionNumber: version.versionNumber,
  createdAt: version.createdAt,
});

export const createUserStackService = (ctx: UserStackServiceContext) => {
  /** The approved Skills currently in the user's `main` environment, keyed by skillId —
   *  reads the SAME private bundle `/skills` already reads, never fetches Git. Throws if any
   *  requested id isn't a current approved Skill (fail closed: never silently drop one). */
  const loadApprovedSkills = async (
    userId: string,
    skillIds: readonly string[],
  ): Promise<Map<string, PortableLockedSkill>> => {
    const environment = await ctx.repository.getEnvironmentByName(
      userId,
      'main',
    );
    const version = environment?.latestVersionId
      ? await ctx.repository.getEnvironmentVersion(environment.latestVersionId)
      : null;
    const skills = version?.bundle.resolved.skills ?? {};
    const result = new Map<string, PortableLockedSkill>();
    const missing: string[] = [];
    for (const skillId of skillIds) {
      const skill = skills[skillId];
      if (!skill) {
        missing.push(skillId);
        continue;
      }
      result.set(skillId, skill);
    }
    if (missing.length > 0)
      throw notFound(
        'skill-not-found',
        `No such Skill(s) in main: ${missing.join(', ')}.`,
      );
    return result;
  };

  const toBundleSkill = (
    skillId: string,
    skill: PortableLockedSkill,
    paused?: boolean,
  ): UserStackSkill => ({
    skillId,
    name: skill.name,
    contentHash: skill.contentHash,
    metadata: skill.metadata ?? {
      name: skill.name,
      description: skill.description,
    },
    restoration: skill.restoration,
    observedSources: skill.observedSources,
    ...(skill.preferredSource
      ? { preferredSource: skill.preferredSource }
      : {}),
    ...(paused !== undefined ? { paused } : {}),
  });

  const requireOwnedStack = async (
    userId: string,
    stackId: string,
  ): Promise<UserStackRecord> => {
    const stack = await ctx.repository.getUserStackById(userId, stackId);
    if (!stack) throw notFound('user-stack-not-found', 'No such Stack.');
    return stack;
  };

  const latestVersionOf = async (
    stack: UserStackRecord,
  ): Promise<UserStackVersionRecord | null> =>
    stack.latestVersionId
      ? ctx.repository.getUserStackVersion(stack.latestVersionId)
      : null;

  const commitVersion = async (
    userId: string,
    name: string,
    bundle: UserStackBundle,
    expectedLatestVersionId: string | null,
    stackId?: string,
  ) => {
    const digest = sha256CanonicalJson(bundle);
    try {
      return await ctx.repository.commitUserStackVersion({
        userId,
        name,
        bundle,
        digest,
        expectedLatestVersionId,
        ids: { stackId: stackId ?? ctx.newId(), versionId: ctx.newId() },
        now: ctx.nowIso(),
      });
    } catch (error) {
      if (error instanceof UserStackConflict)
        throw notFound(
          'user-stack-conflict',
          'This Stack changed since it was last loaded. Reload and try again.',
        );
      throw error;
    }
  };

  return {
    listUserStacks: async (
      user: AuthenticatedUser,
    ): Promise<ListUserStacksResponse> => {
      const stacks = await ctx.repository.listUserStacks(user.userId);
      const summaries = await Promise.all(
        stacks.map(async (stack) => {
          const version = await latestVersionOf(stack);
          return {
            stackId: stack.stackId,
            name: stack.name,
            description: version?.bundle.description ?? '',
            skillCount: version?.bundle.skills.length ?? 0,
            updatedAt: version?.createdAt ?? null,
            versionNumber: version?.versionNumber ?? 0,
          };
        }),
      );
      return { stacks: summaries };
    },

    getUserStack: async (
      user: AuthenticatedUser,
      stackId: string,
    ): Promise<UserStackDetail> => {
      const stack = await requireOwnedStack(user.userId, stackId);
      const version = await latestVersionOf(stack);
      return {
        stackId: stack.stackId,
        name: stack.name,
        description: version?.bundle.description ?? '',
        skills: version?.bundle.skills ?? [],
        version: version ? versionSummary(version) : null,
      };
    },

    /** Fetch-by-name for `stak use <name>` (§14) — owner-authenticated, never resolves
     *  anything not owned by the caller. 404s (via `notFound`) when no Stack has that name. */
    getUserStackByName: async (
      user: AuthenticatedUser,
      name: string,
    ): Promise<GetUserStackResponse> => {
      const stack = await ctx.repository.getUserStackByName(user.userId, name);
      if (!stack) throw notFound('user-stack-not-found', 'No such Stack.');
      const version = await latestVersionOf(stack);
      if (!version)
        throw notFound(
          'user-stack-not-found',
          `"${stack.name}" has no published version yet.`,
        );
      return {
        stackId: stack.stackId,
        name: stack.name,
        bundle: version.bundle,
        version: versionSummary(version),
      };
    },

    createUserStack: async (
      user: AuthenticatedUser,
      request: CreateUserStackRequest,
    ): Promise<CreateUserStackResponse> => {
      const existing = await ctx.repository.getUserStackByName(
        user.userId,
        request.name,
      );
      if (existing)
        throw notFound(
          'user-stack-name-conflict',
          `A Stack named "${request.name}" already exists.`,
        );
      const approved = await loadApprovedSkills(user.userId, request.skillIds);
      const bundle: UserStackBundle = {
        schemaVersion: 1,
        name: request.name,
        description: request.description ?? '',
        skills: [...approved.entries()].map(([skillId, skill]) =>
          toBundleSkill(skillId, skill),
        ),
      };
      const outcome = await commitVersion(
        user.userId,
        request.name,
        bundle,
        null,
      );
      return {
        stackId: outcome.stack.stackId,
        name: outcome.stack.name,
        version: versionSummary(outcome.version),
      };
    },

    updateUserStack: async (
      user: AuthenticatedUser,
      request: UpdateUserStackRequest,
    ): Promise<UpdateUserStackResponse> => {
      let stack = await requireOwnedStack(user.userId, request.stackId);

      if (request.name !== undefined && request.name !== stack.name) {
        try {
          const renamed = await ctx.repository.renameUserStack(
            user.userId,
            stack.stackId,
            request.name,
          );
          if (renamed) stack = renamed;
        } catch (error) {
          if (error instanceof UserStackNameConflict)
            throw notFound('user-stack-name-conflict', error.message);
          throw error;
        }
      }

      const current = await latestVersionOf(stack);
      if (request.skills === undefined && request.description === undefined)
        return {
          stackId: stack.stackId,
          name: stack.name,
          version: current ? versionSummary(current) : null,
        };

      const skillIds = request.skills
        ? request.skills.map((s) => s.skillId)
        : (current?.bundle.skills.map((s) => s.skillId) ?? []);
      const pausedById = new Map(
        (request.skills ?? current?.bundle.skills ?? []).map((s) => [
          s.skillId,
          s.paused,
        ]),
      );
      const approved = await loadApprovedSkills(user.userId, skillIds);
      const bundle: UserStackBundle = {
        schemaVersion: 1,
        name: stack.name,
        description: request.description ?? current?.bundle.description ?? '',
        skills: [...approved.entries()].map(([skillId, skill]) =>
          toBundleSkill(skillId, skill, pausedById.get(skillId)),
        ),
      };
      const outcome = await commitVersion(
        user.userId,
        stack.name,
        bundle,
        request.expectedLatestVersionId,
        stack.stackId,
      );
      return {
        stackId: outcome.stack.stackId,
        name: outcome.stack.name,
        version: versionSummary(outcome.version),
      };
    },

    /**
     * Publish a named Stack publicly (§15) — reuses the existing public-Stack pipeline exactly
     * like Skill-sharing (§3): builds a reference-only bundle and hands it to the same
     * `publishPublicStackVersion`. Fails closed, never partially, if ANY Skill in the Stack
     * isn't eligible — never silently drops an ineligible Skill from the published bundle.
     */
    publishUserStack: async (
      user: AuthenticatedUser,
      request: PublishUserStackRequest,
    ): Promise<PublishPublicStackVersionResponse> => {
      const stack = await requireOwnedStack(user.userId, request.stackId);
      const version = await latestVersionOf(stack);
      if (!version || version.bundle.skills.length === 0)
        throw publicationNotEligible(
          `"${stack.name}" has no Skills yet — nothing to publish.`,
        );
      const ineligible: string[] = [];
      for (const skill of version.bundle.skills) {
        const verdict = assessSkillShareEligibility(skill.restoration);
        if (!verdict.eligible)
          ineligible.push(`${skill.name} (${verdict.reason})`);
      }
      if (ineligible.length > 0)
        throw publicationNotEligible(
          `Cannot publish "${stack.name}". ${ineligible.length} Skill(s) can't be published: ${ineligible.join('; ')}.`,
        );

      const name = request.displayName ?? stack.name;
      const description = request.description ?? version.bundle.description;
      const requirements: PublicStackRequirement[] = version.bundle.skills.map(
        (skill) => {
          // Safe: every skill above passed assessSkillShareEligibility, which only accepts
          // reference-strategy restorations — this narrows the type the same runtime fact
          // already guarantees.
          if (skill.restoration.strategy !== 'reference')
            throw publicationNotEligible(
              `Cannot publish "${stack.name}". ${skill.name} is not reference-backed.`,
            );
          return {
            id: `req_${ctx.newId().replace(/-/g, '')}`,
            name: skill.name,
            requirement: 'required' as const,
            contentHash: skill.contentHash,
            metadata: skill.metadata,
            restoration: skill.restoration,
            observedSources: skill.observedSources,
            ...(skill.preferredSource
              ? { preferredSource: skill.preferredSource }
              : {}),
            originStackName: stack.name,
          };
        },
      );
      const inheritedStackMetadata: PublicStackBundle['inheritedStackMetadata'] =
        [];
      const versionHash = sha256CanonicalJson({
        name,
        description,
        requirements,
        inheritedStacks: inheritedStackMetadata,
        skippedOptional: [],
      });
      const stackField: PublicStackBundle['stack'] = {
        name,
        description,
        versionHash,
        kind: 'stack',
      };
      const digest = sha256CanonicalJson({
        stack: stackField,
        requirements,
        inheritedStackMetadata,
      });
      const bundle: PublicStackBundle = {
        schemaVersion: 1,
        stack: stackField,
        requirements,
        inheritedStackMetadata,
        digest,
      };
      return ctx.publishPublicStackVersion(user, {
        slug: request.slug,
        displayName: name,
        description,
        bundle,
        expectedLatestVersionId: null,
      });
    },
  };
};

export type UserStackService = ReturnType<typeof createUserStackService>;
