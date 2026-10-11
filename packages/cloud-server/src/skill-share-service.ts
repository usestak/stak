import { sha256CanonicalJson } from '@stack/shared';
import {
  assessSkillShareEligibility,
  publicSlugSchema,
  type GetSkillShareStatusResponse,
  type PublicStackBundle,
  type PublicStackRequirement,
  type PublishPublicStackVersionResponse,
  type ShareSkillRequest,
} from '@stack/spec';

import { notFound, publicationNotEligible } from './errors.js';
import type { CloudRepository, PublicStackRepository } from './repository.js';
import type { AuthenticatedUser } from './service.js';

export type SkillShareServiceContext = {
  repository: CloudRepository & PublicStackRepository;
  newId: () => string;
  resolveHandle: (userId: string) => Promise<string>;
  publishPublicStackVersion: (
    user: AuthenticatedUser,
    request: {
      slug: string;
      displayName?: string;
      description?: string;
      bundle: PublicStackBundle;
      expectedLatestVersionId: string | null;
      idempotencyKey?: string;
    },
  ) => Promise<PublishPublicStackVersionResponse>;
};

/** Suggest a slug-safe default from a Skill's display name; falls back to the entry id. */
const suggestSlug = (name: string, skillId: string): string => {
  const candidate = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return publicSlugSchema.safeParse(candidate).success
    ? candidate
    : skillId.replace(/^skill_/, 'skill-');
};

export const createSkillShareService = (ctx: SkillShareServiceContext) => {
  /** The Skill as currently approved in the user's `main` environment, or a not-found error.
   *  Reads the SAME private bundle `/skills/[skillId]` already reads — never fetches Git,
   *  never touches `skill_review_checks` (P5a stays untouched by sharing). */
  const requireSkill = async (userId: string, skillId: string) => {
    const environment = await ctx.repository.getEnvironmentByName(
      userId,
      'main',
    );
    const version = environment?.latestVersionId
      ? await ctx.repository.getEnvironmentVersion(environment.latestVersionId)
      : null;
    const skill = version?.bundle.resolved.skills[skillId];
    if (!version || version.userId !== userId || !skill)
      throw notFound('skill-not-found', 'No such Skill.');
    return skill;
  };

  /** Scan the owner's own public Stacks for one whose bundle is a Skill-share of `skillId`.
   *  Linear over the owner's published-Stack count (same pattern `getPublicProfile` already
   *  uses) — no new table, no new index; V0-bounded by how many things one account publishes. */
  const findExistingShare = async (userId: string, handle: string, skillId: string) => {
    const owned = await ctx.repository.listPublicStacksByHandle(handle);
    for (const stack of owned) {
      if (stack.ownerUserId !== userId || !stack.latestVersionId) continue;
      const latest = await ctx.repository.getPublicStackVersionById(
        stack.latestVersionId,
      );
      if (
        latest &&
        latest.bundle.stack.kind === 'skill' &&
        latest.bundle.stack.originSkillId === skillId
      )
        return { stack, latest };
    }
    return null;
  };

  return {
    getSkillShareStatus: async (
      user: AuthenticatedUser,
      skillId: string,
    ): Promise<GetSkillShareStatusResponse> => {
      const skill = await requireSkill(user.userId, skillId);
      const existingHandle = await ctx.repository.getHandleForUser(
        user.userId,
      );
      if (existingHandle) {
        const existing = await findExistingShare(
          user.userId,
          existingHandle,
          skillId,
        );
        if (existing)
          return {
            skillId,
            share: {
              status: 'already-shared',
              owner: existingHandle,
              slug: existing.stack.slug,
              url: `/@${existingHandle}/${existing.stack.slug}`,
              versionNumber: existing.latest.versionNumber,
            },
          };
      }
      const eligibility = assessSkillShareEligibility(skill.restoration);
      if (!eligibility.eligible)
        return {
          skillId,
          share: { status: 'not-shareable', reason: eligibility.reason },
        };
      return {
        skillId,
        share: {
          status: 'shareable',
          suggestedSlug: suggestSlug(skill.name, skillId),
        },
      };
    },

    /**
     * Publish a Skill via the existing one-item public Stack pipeline (§3): builds a
     * reference-only bundle from the Skill's current approved restoration and hands it to the
     * SAME `publishPublicStackVersion` every Stack publish goes through — same eligibility
     * re-check, same digest/immutability guarantees, same owner-handle resolution. No second
     * publication system; the only new code here is bundle construction.
     */
    shareSkill: async (
      user: AuthenticatedUser,
      request: ShareSkillRequest,
    ): Promise<PublishPublicStackVersionResponse> => {
      const skill = await requireSkill(user.userId, request.skillId);
      const eligibility = assessSkillShareEligibility(skill.restoration);
      if (!eligibility.eligible || skill.restoration.strategy !== 'reference')
        throw publicationNotEligible(eligibility.eligible ? 'Not shareable.' : eligibility.reason);

      const handle = await ctx.resolveHandle(user.userId);
      const existing = await findExistingShare(
        user.userId,
        handle,
        request.skillId,
      );
      const requirementId = `req_${ctx.newId().replace(/-/g, '')}`;
      const name = request.displayName ?? skill.name;
      const description =
        request.description ?? skill.metadata?.description ?? skill.description;
      const requirements: PublicStackRequirement[] = [
        {
          id: requirementId,
          name: skill.name,
          requirement: 'required',
          contentHash: skill.contentHash,
          metadata: skill.metadata ?? { name: skill.name, description },
          restoration: skill.restoration,
          observedSources: skill.observedSources,
          ...(skill.preferredSource
            ? { preferredSource: skill.preferredSource }
            : {}),
          originStackName: skill.name,
        },
      ];
      const inheritedStackMetadata: PublicStackBundle['inheritedStackMetadata'] =
        [];
      // Same canonical-JSON hashing a CLI-built Stack bundle uses (`stackVersionHash` /
      // `publicBundleDigestInput` in packages/core), reproduced here with the shared
      // primitive so a client resolving this bundle later (`publicBundleToImportedVersion`,
      // packages/core/src/remote-source.ts) recomputes the identical versionHash and accepts
      // it — no separate hashing scheme, no trust shortcut for a server-built bundle.
      const versionHash = sha256CanonicalJson({
        name,
        description,
        requirements,
        inheritedStacks: inheritedStackMetadata,
        skippedOptional: [],
      });
      const stack: PublicStackBundle['stack'] = {
        name,
        description,
        versionHash,
        kind: 'skill',
        originSkillId: request.skillId,
      };
      const digest = sha256CanonicalJson({
        stack,
        requirements,
        inheritedStackMetadata,
      });
      const bundle: PublicStackBundle = {
        schemaVersion: 1,
        stack,
        requirements,
        inheritedStackMetadata,
        digest,
      };
      return ctx.publishPublicStackVersion(user, {
        slug: request.slug,
        displayName: name,
        description,
        bundle,
        expectedLatestVersionId: existing?.stack.latestVersionId ?? null,
      });
    },
  };
};

export type SkillShareService = ReturnType<typeof createSkillShareService>;
