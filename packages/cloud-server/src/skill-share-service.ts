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
import {
  guardPublicSlugClaim,
  hasPublishableSnapshot,
} from './public-service.js';
import type {
  CloudBlobStore,
  CloudRepository,
  PublicStackRepository,
} from './repository.js';
import type { AuthenticatedUser } from './service.js';

export type SkillShareServiceContext = {
  repository: CloudRepository & PublicStackRepository;
  blobStore: CloudBlobStore;
  newId: () => string;
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
      idempotencyKey?: string;
    },
  ) => Promise<PublishPublicStackVersionResponse>;
  unpublishPublicStack: (
    user: AuthenticatedUser,
    request: { slug: string },
  ) => Promise<void>;
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
  const findExistingShare = async (
    userId: string,
    handle: string,
    skillId: string,
  ) => {
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
      const existingHandle = await ctx.repository.getHandleForUser(user.userId);
      if (existingHandle) {
        const existing = await findExistingShare(
          user.userId,
          existingHandle,
          skillId,
        );
        // Active-share rule (§5/§9): an unpublished share reads back as not-currently-shared
        // here — it falls through to the eligibility check below, so the UI shows
        // "Shareable" again — even though `findExistingShare` (deliberately unfiltered) can
        // still find it internally so re-sharing reactivates the SAME slug/history (§10/§11).
        if (existing && existing.stack.unpublishedAt === null) {
          // Truthful lifecycle (spec P10 correction §3), updated for public-publication
          // parity: `shareSkill` now ALWAYS publishes through the Skill's immutable content
          // snapshot (see `shareSkill` below), so the published requirement's restoration is
          // always `{ strategy: 'snapshot', contentHash }` regardless of whether the
          // currently-approved Skill is itself Git-backed or local. Comparing the full
          // `restoration` object against the currently-approved Skill's (which keeps its own
          // local Git-reference/snapshot shape) would therefore never match for a Git-backed
          // Skill, permanently reporting "update-available" even immediately after sharing.
          // What "already-shared" actually means under content-pinned publication is: the
          // content currently approved is the same content already published AND that
          // publication is itself snapshot-backed (not a pre-snapshot-first legacy reference
          // row) — contentHash equality alone is no longer sufficient (§ legacy publication
          // policy: a legacy reference-strategy publication is never treated as "current",
          // even when its contentHash happens to match).
          const publishedRequirement = existing.latest.bundle.requirements[0];
          const legacy =
            publishedRequirement?.restoration.strategy !== 'snapshot';
          const upToDate =
            !legacy && publishedRequirement?.contentHash === skill.contentHash;
          const shareMeta = {
            owner: existingHandle,
            slug: existing.stack.slug,
            // Canonical browser share URL, not the `@owner/slug` CLI locator — see the
            // matching comment in public-service.ts's `url()` helper.
            url: `${ctx.appUrl.replace(/\/+$/, '')}/${existingHandle}/${existing.stack.slug}`,
            versionNumber: existing.latest.versionNumber,
          };
          if (upToDate)
            return {
              skillId,
              share: { status: 'already-shared', ...shareMeta },
            };
          // Either the publication is a legacy reference row (needs a portable republish) or
          // the currently-approved content has changed since the last snapshot publish (needs
          // an update). Both re-share through the same `shareSkill` call, and both are
          // guaranteed to fail the same way if this content was never pushed — checked here
          // too, same as the never-shared branch below.
          const uploaded = await hasPublishableSnapshot(
            ctx.blobStore,
            user.userId,
            skill.contentHash,
          );
          if (!uploaded)
            return { skillId, share: { status: 'upload-required' } };
          return {
            skillId,
            share: {
              status: legacy ? 'portable-republish-needed' : 'update-available',
              ...shareMeta,
            },
          };
        }
      }
      const eligibility = assessSkillShareEligibility(skill.restoration);
      if (!eligibility.eligible)
        return {
          skillId,
          share: { status: 'not-shareable', reason: eligibility.reason },
        };
      // Public-publication parity: a share always publishes through the Skill's immutable
      // content snapshot (see `shareSkill` below), regardless of restoration strategy, so the
      // bytes must already be in STAK Cloud or the actual share attempt is guaranteed to fail
      // with `ensurePublicSnapshotUploaded`'s error. Checked here too so the UI never shows a
      // normal Share action it already knows would fail — it tells the owner to `stak push`
      // first instead.
      const uploaded = await hasPublishableSnapshot(
        ctx.blobStore,
        user.userId,
        skill.contentHash,
      );
      if (!uploaded) return { skillId, share: { status: 'upload-required' } };
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
      if (!eligibility.eligible)
        throw publicationNotEligible(eligibility.reason);
      // Public-publication parity: every Skill publishes through its immutable content
      // snapshot, whether its LOCAL restoration is Git-backed or not — exactly like the
      // CLI's `buildPublicStackBundle` (packages/core/src/public-stack.ts). There is no
      // Git-reference public-publication path anymore; `ensurePublicSnapshotUploaded`
      // (inside `publishPublicStackVersion`, which this bundle is handed to below) enforces
      // that the owner has already run `stak push` for this exact content, failing closed
      // with an actionable message if not.
      const restoration: PublicStackRequirement['restoration'] = {
        strategy: 'snapshot',
        contentHash: skill.contentHash,
      };

      const handle = await ctx.resolveHandle(user.userId);
      const existing = await findExistingShare(
        user.userId,
        handle,
        request.skillId,
      );
      // Deterministic, not `ctx.newId()` (correction pass fix — same bug as the named-Stack
      // publish path): a random id made the bundle hash non-reproducible between calls,
      // breaking the identical-content no-op shortcut on re-share.
      const requirementId = `req_${request.skillId.replace(/^skill_/, '')}`;
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
          restoration,
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
      // The immutable public snapshot (if any) is validated/uploaded centrally inside
      // `publishPublicStackVersion` itself (the one place every publish path converges) —
      // not duplicated here.
      // Slug-ownership invariant (§11/§12) — same guard, same reasoning as the named-Stack
      // publish path: this Skill's own previously-used slug (if any) is the only one it may
      // keep publishing under, and a slug it doesn't already own must not belong to another
      // Skill/Stack in this account.
      await guardPublicSlugClaim(
        ctx.repository,
        user.userId,
        request.slug,
        existing?.stack.slug ?? null,
      );
      return ctx.publishPublicStackVersion(user, {
        slug: request.slug,
        displayName: name,
        description,
        bundle,
        expectedLatestVersionId: existing?.stack.latestVersionId ?? null,
      });
    },

    /** Owner-only, idempotent unshare (spec final lifecycle pass §7): deactivates the public
     *  share only — the local Skill, its approved revision, and `main` are all untouched, and
     *  history is retained so sharing again reactivates the SAME slug/history. A no-op when
     *  the Skill was never shared or is already unshared. */
    unshareSkill: async (
      user: AuthenticatedUser,
      skillId: string,
    ): Promise<void> => {
      const existingHandle = await ctx.repository.getHandleForUser(user.userId);
      if (!existingHandle) return;
      const existing = await findExistingShare(
        user.userId,
        existingHandle,
        skillId,
      );
      if (!existing) return;
      await ctx.unpublishPublicStack(user, { slug: existing.stack.slug });
    },
  };
};

export type SkillShareService = ReturnType<typeof createSkillShareService>;
