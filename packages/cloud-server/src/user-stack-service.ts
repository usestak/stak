import { sha256CanonicalJson } from '@stack/shared';
import {
  assessSkillShareEligibility,
  userStackNameSchema,
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

import { invalidRequest, notFound, publicationNotEligible } from './errors.js';
import { guardPublicSlugClaim, hasPublishableSnapshot } from './public-service.js';
import {
  UserStackConflict,
  UserStackNameConflict,
  type CloudBlobStore,
  type CloudRepository,
  type PublicStackRepository,
  type UserStackRepository,
  type UserStackRecord,
  type UserStackVersionRecord,
} from './repository.js';
import type { AuthenticatedUser } from './service.js';

export type UserStackServiceContext = {
  repository: CloudRepository & UserStackRepository & PublicStackRepository;
  blobStore: CloudBlobStore;
  newId: () => string;
  nowIso: () => string;
  appUrl: string;
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
  unpublishPublicStack: (
    user: AuthenticatedUser,
    request: { slug: string },
  ) => Promise<void>;
};

/** The ONE place a named-Stack name is canonicalized/validated server-side (spec P10
 *  correction §1/§5) — called directly by the service so a caller that reaches this code
 *  without going through the HTTP handler's schema `.parse()` (the web app calls these
 *  methods in-process, not over HTTP) still can't create/rename to an invalid or reserved
 *  name. Trim + lowercase, reject `main`, reject `@`-prefixed, reject invalid characters. */
const canonicalName = (raw: string): string => {
  const result = userStackNameSchema.safeParse(raw);
  if (!result.success)
    throw invalidRequest(
      result.error.issues[0]?.message ??
        'Stack names must be lowercase letters, numbers, hyphens, and underscores, and may not be "main".',
    );
  return result.data;
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
      ? ctx.repository.getUserStackVersion(stack.userId, stack.latestVersionId)
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

  /**
   * Build the reference-only public bundle a named Stack WOULD publish as, re-validating
   * eligibility against the composition passed in — never cached from a prior publish (spec
   * P10 correction §12: republish must revalidate current eligibility, a Stack that was
   * publishable at version 1 is not assumed publishable forever). Shared by `publishUserStack`
   * (which throws on ineligibility) and `getUserStackPublicationStatus` (which only needs to
   * know eligible-or-not to compare version hashes) so there is exactly one place this logic
   * lives.
   */
  const buildCandidateBundle = async (
    userId: string,
    stack: UserStackRecord,
    version: UserStackVersionRecord | null,
    displayNameOverride?: string,
    descriptionOverride?: string,
  ): Promise<
    | {
        eligible: true;
        bundle: PublicStackBundle;
        displayName: string;
        description: string;
      }
    | { eligible: false; reason: string }
  > => {
    if (!version || version.bundle.skills.length === 0)
      return {
        eligible: false,
        reason: `"${stack.name}" has no Skills yet — nothing to publish.`,
      };
    const ineligible: string[] = [];
    for (const skill of version.bundle.skills) {
      const verdict = assessSkillShareEligibility(skill.restoration);
      if (!verdict.eligible) {
        ineligible.push(`${skill.name} (${verdict.reason})`);
        continue;
      }
      // Public-publication parity: every Skill will be published as a snapshot (see the
      // restoration-building step below), so its content must already be uploaded —
      // checked here, up front, so ALL missing Skills are named in one combined error
      // instead of failing on whichever happens to be checked first inside
      // `publishPublicStackVersion`.
      const available = await hasPublishableSnapshot(
        ctx.blobStore,
        userId,
        skill.contentHash,
      );
      if (!available)
        ineligible.push(
          `${skill.name} (content not yet uploaded to STAK Cloud — run \`stak push\` first)`,
        );
    }
    if (ineligible.length > 0)
      return {
        eligible: false,
        reason: `Cannot publish "${stack.name}". ${ineligible.length} Skill(s) can't be published: ${ineligible.join('; ')}.`,
      };

    const displayName = displayNameOverride ?? stack.name;
    const description = descriptionOverride ?? version.bundle.description;
    const requirements: PublicStackRequirement[] = version.bundle.skills.map(
      (skill) => {
        // Public-publication parity: always snapshot-strategy (see the pre-check above,
        // which already guaranteed this skill's content is uploaded before we reach here).
        const restoration: PublicStackRequirement['restoration'] = {
          strategy: 'snapshot',
          contentHash: skill.contentHash,
        };
        return {
          // Deterministic, not `ctx.newId()` (bug fixed by this correction pass): a random
          // id made the published bundle's hash non-reproducible between calls, which broke
          // both the identical-republish no-op shortcut and publication-status comparison —
          // every rebuild of "the same" composition hashed differently. Matches the existing
          // deterministic pattern in `owned-stack-source.ts`.
          id: `req_${skill.skillId.replace(/^skill_/, '')}`,
          name: skill.name,
          requirement: 'required' as const,
          contentHash: skill.contentHash,
          metadata: skill.metadata,
          restoration,
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
      name: displayName,
      description,
      requirements,
      inheritedStacks: inheritedStackMetadata,
      skippedOptional: [],
    });
    const stackField: PublicStackBundle['stack'] = {
      name: displayName,
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
    return { eligible: true, bundle, displayName, description };
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
      const name = canonicalName(request.name);
      const existing = await ctx.repository.getUserStackByName(
        user.userId,
        name,
      );
      if (existing)
        throw notFound(
          'user-stack-name-conflict',
          `A Stack named "${name}" already exists.`,
        );
      const approved = await loadApprovedSkills(user.userId, request.skillIds);
      const bundle: UserStackBundle = {
        schemaVersion: 1,
        name,
        description: request.description ?? '',
        skills: [...approved.entries()].map(([skillId, skill]) =>
          toBundleSkill(skillId, skill),
        ),
      };
      const outcome = await commitVersion(user.userId, name, bundle, null);
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

      if (request.name !== undefined) {
        const name = canonicalName(request.name);
        if (name !== stack.name) {
          try {
            const renamed = await ctx.repository.renameUserStack(
              user.userId,
              stack.stackId,
              name,
            );
            if (renamed) stack = renamed;
          } catch (error) {
            if (error instanceof UserStackNameConflict)
              throw notFound('user-stack-name-conflict', error.message);
            throw error;
          }
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

    publishUserStack: async (
      user: AuthenticatedUser,
      request: PublishUserStackRequest,
    ): Promise<PublishPublicStackVersionResponse> => {
      const stack = await requireOwnedStack(user.userId, request.stackId);
      const version = await latestVersionOf(stack);
      const candidate = await buildCandidateBundle(
        user.userId,
        stack,
        version,
        request.displayName,
        request.description,
      );
      if (!candidate.eligible) throw publicationNotEligible(candidate.reason);
      // Every snapshot-backed requirement's immutable public bytes are validated/uploaded
      // centrally inside `publishPublicStackVersion` itself (the one place every publish
      // path converges) — not duplicated here.
      // Slug-ownership invariant (spec final lifecycle pass §11/§12): this Stack's OWN bound
      // slug (if any) is the only slug it may ever publish/republish under; a slug it does
      // not already own must not already belong to a different Skill/Stack in this account —
      // guards against unpublishing silently freeing a slug for a different source to claim,
      // and against a slug silently changing after first publish.
      await guardPublicSlugClaim(
        ctx.repository,
        user.userId,
        request.slug,
        stack.publishedSlug,
      );
      // Republish fix (spec P10 correction §2): the server — never the caller — resolves the
      // CURRENT public Stack latest-version id for this (owner, slug). First publish has no
      // existing row, so `expectedLatestVersionId` is correctly null; every later publish
      // commits optimistically against the real current version, so `publishPublicStackVersion`
      // can both no-op cleanly on identical content and reject a genuinely stale/concurrent
      // writer with STACK_PUBLIC_CONFLICT — exactly like `shareSkill`'s existing
      // `findExistingShare(...)?.stack.latestVersionId` already does for one-Skill shares.
      const existingPublication = await ctx.repository.getPublicStackByOwner(
        user.userId,
        request.slug,
      );
      const result = await ctx.publishPublicStackVersion(user, {
        slug: request.slug,
        displayName: candidate.displayName,
        description: candidate.description,
        bundle: candidate.bundle,
        expectedLatestVersionId: existingPublication?.latestVersionId ?? null,
      });
      // Record WHICH slug this named Stack is published under so `getUserStackPublicationStatus`
      // can resolve a truthful status on reload (§13) — best-effort bookkeeping; the publish
      // itself already succeeded above, so a failure here would be a bug worth surfacing, not
      // swallowing, but it must never roll back a publish that genuinely happened.
      await ctx.repository.markUserStackPublished(
        user.userId,
        stack.stackId,
        request.slug,
      );
      return result;
    },

    /** Truthful publication lifecycle (spec P10 correction §13) — resolved server-side on
     *  every call, never cached client-side, so a reload always shows the real state. */
    getUserStackPublicationStatus: async (
      user: AuthenticatedUser,
      stackId: string,
    ): Promise<{
      stackId: string;
      publication:
        | { status: 'private' }
        | {
            status: 'published' | 'changed-since-published';
            owner: string;
            slug: string;
            url: string;
            versionNumber: number;
          };
    }> => {
      const stack = await requireOwnedStack(user.userId, stackId);
      if (!stack.publishedSlug)
        return { stackId: stack.stackId, publication: { status: 'private' } };
      const published = await ctx.repository.getPublicStackByOwner(
        user.userId,
        stack.publishedSlug,
      );
      // Active-share rule (§5/§9): `publishedSlug` is a stable identity binding, NOT an
      // activity flag — an unpublished share (unpublishedAt set) reads back as 'private' here
      // even though the slug binding is retained internally for a future republish/reactivate.
      if (
        !published ||
        !published.latestVersionId ||
        published.unpublishedAt !== null
      )
        return { stackId: stack.stackId, publication: { status: 'private' } };
      const publishedVersion = await ctx.repository.getPublicStackVersionById(
        published.latestVersionId,
      );
      const handle = await ctx.resolveHandle(user.userId);
      // Canonical browser share URL, not the `@owner/slug` CLI locator — see the
      // matching comment in public-service.ts's `url()` helper.
      const url = `${ctx.appUrl.replace(/\/+$/, '')}/${handle}/${stack.publishedSlug}`;
      const version = await latestVersionOf(stack);
      const candidate = await buildCandidateBundle(user.userId, stack, version);
      const upToDate =
        candidate.eligible &&
        publishedVersion?.versionHash === candidate.bundle.stack.versionHash;
      return {
        stackId: stack.stackId,
        publication: {
          status: upToDate ? 'published' : 'changed-since-published',
          owner: handle,
          slug: stack.publishedSlug,
          url,
          versionNumber: publishedVersion?.versionNumber ?? 0,
        },
      };
    },

    /** Owner-only, idempotent unpublish (spec final lifecycle pass §8): deactivates the
     *  public share only — `user_stacks`/every `user_stack_versions` row, `main`, and the
     *  slug binding itself are all untouched, so a later publish reactivates the SAME public
     *  identity and history (§10/§11) rather than creating something new. */
    unpublishUserStack: async (
      user: AuthenticatedUser,
      stackId: string,
    ): Promise<{ stackId: string; publication: { status: 'private' } }> => {
      const stack = await requireOwnedStack(user.userId, stackId);
      if (stack.publishedSlug)
        await ctx.unpublishPublicStack(user, { slug: stack.publishedSlug });
      return { stackId: stack.stackId, publication: { status: 'private' } };
    },
  };
};

export type UserStackService = ReturnType<typeof createUserStackService>;
