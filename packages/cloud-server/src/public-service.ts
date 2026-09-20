import {
  formatPublicStackRef,
  inspectPublicSourceRemote,
  publicHandleSchema,
  publicSlugSchema,
} from '@stack/spec';
import type {
  GetPublicStackResponse,
  GetPublicStackVersionResponse,
  PublicProfileResponse,
  PublicStackBundle,
  PublishPublicStackVersionRequest,
  PublishPublicStackVersionResponse,
} from '@stack/spec';
import { sha256CanonicalJson } from '@stack/shared';

import {
  bundleInvalid,
  handleUnavailable,
  invalidSlug,
  publicStackConflict,
  publicStackNotFound,
  publicationNotEligible,
} from './errors.js';
import {
  PublicStackConflict,
  type CloudRepository,
  type PublicStackRepository,
  type PublicStackVersionRecord,
} from './repository.js';
import type { AuthenticatedUser } from './service.js';

const MAX_REQUIREMENTS = 500;

export type PublicServiceContext = {
  repository: CloudRepository & PublicStackRepository;
  nowIso: () => string;
  newId: () => string;
  appUrl: string;
};

/** Canonical digest input for a public bundle (excludes the digest field). */
const digestInput = (bundle: PublicStackBundle) => ({
  stack: bundle.stack,
  requirements: bundle.requirements,
  inheritedStackMetadata: bundle.inheritedStackMetadata,
});

const normalizeHandle = (raw: string | undefined): string | null => {
  if (!raw) return null;
  const candidate = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39)
    .replace(/-+$/g, '');
  return publicHandleSchema.safeParse(candidate).success ? candidate : null;
};

const summary = (version: PublicStackVersionRecord) => ({
  versionId: version.versionId,
  versionNumber: version.versionNumber,
  versionHash: version.versionHash,
  digest: version.digest,
  createdAt: version.createdAt,
});

export const createPublicStackService = (ctx: PublicServiceContext) => {
  const resolveHandle = async (userId: string): Promise<string> => {
    const existing = await ctx.repository.getHandleForUser(userId);
    if (existing) return existing;
    const profile = await ctx.repository.getProfile(userId);
    const candidate = normalizeHandle(profile?.githubUsername);
    if (!candidate)
      throw handleUnavailable(
        'Could not derive a valid public handle for this account.',
      );
    const owner = await ctx.repository.findHandleOwner(candidate);
    if (owner && owner !== userId)
      throw handleUnavailable(
        `The public handle @${candidate} is already taken.`,
      );
    if (!owner)
      try {
        await ctx.repository.reserveHandle({
          userId,
          handle: candidate,
          createdAt: ctx.nowIso(),
        });
      } catch (error) {
        if (error instanceof PublicStackConflict)
          throw handleUnavailable(
            `The public handle @${candidate} is already taken.`,
          );
        throw error;
      }
    return candidate;
  };

  const url = (handle: string, slug: string) =>
    `${ctx.appUrl.replace(/\/+$/, '')}/@${handle}/${slug}`;

  return {
    resolveHandle,

    publishPublicStackVersion: async (
      user: AuthenticatedUser,
      request: PublishPublicStackVersionRequest,
    ): Promise<PublishPublicStackVersionResponse> => {
      const slug = request.slug;
      if (!publicSlugSchema.safeParse(slug).success)
        throw invalidSlug(`Invalid Stack slug: ${slug}`);
      const bundle = request.bundle;
      if (bundle.requirements.length > MAX_REQUIREMENTS)
        throw publicationNotEligible(
          `A public Stack version may contain at most ${MAX_REQUIREMENTS} Skills.`,
        );

      // Reference-only + source-remote safety (schema already enforces reference).
      for (const requirement of bundle.requirements) {
        const verdict = inspectPublicSourceRemote(
          requirement.restoration.reference.remote,
        );
        if (!verdict.safe)
          throw publicationNotEligible(
            `Skill ${requirement.name} cannot be published: ${verdict.reason}`,
          );
      }

      // Digest integrity: recompute and require equality.
      if (sha256CanonicalJson(digestInput(bundle)) !== bundle.digest)
        throw bundleInvalid('Public Stack bundle digest does not match.');

      const handle = await resolveHandle(user.userId);
      const displayName = request.displayName ?? bundle.stack.name;
      const description = request.description ?? bundle.stack.description;

      if (request.idempotencyKey) {
        const existing = await ctx.repository.findPublicVersionByIdempotencyKey(
          user.userId,
          request.idempotencyKey,
        );
        if (existing)
          return {
            owner: handle,
            slug,
            stackId: existing.stackId,
            version: summary(existing),
            url: url(handle, slug),
            createdNew: false,
          };
      }

      // No-op: latest already carries this exact version hash.
      const current = await ctx.repository.getPublicStackByOwner(
        user.userId,
        slug,
      );
      if (
        current?.latestVersionId &&
        current.latestVersionId === request.expectedLatestVersionId
      ) {
        const latest = await ctx.repository.getPublicStackVersionById(
          current.latestVersionId,
        );
        if (latest && latest.versionHash === bundle.stack.versionHash)
          return {
            owner: handle,
            slug,
            stackId: latest.stackId,
            version: summary(latest),
            url: url(handle, slug),
            createdNew: false,
          };
      }

      let outcome;
      try {
        outcome = await ctx.repository.commitPublicStackVersion({
          ownerUserId: user.userId,
          ownerHandle: handle,
          slug,
          displayName,
          description,
          bundle,
          digest: bundle.digest,
          versionHash: bundle.stack.versionHash,
          expectedLatestVersionId: request.expectedLatestVersionId,
          ...(request.idempotencyKey
            ? { idempotencyKey: request.idempotencyKey }
            : {}),
          ids: { stackId: ctx.newId(), versionId: ctx.newId() },
          now: ctx.nowIso(),
        });
      } catch (error) {
        if (error instanceof PublicStackConflict)
          throw publicStackConflict(
            'This public Stack changed since it was last fetched. Fetch the latest version and publish again.',
          );
        throw error;
      }
      return {
        owner: handle,
        slug,
        stackId: outcome.stack.stackId,
        version: summary(outcome.version),
        url: url(handle, slug),
        createdNew: outcome.createdNew,
      };
    },

    getPublicStack: async (
      owner: string,
      slug: string,
    ): Promise<GetPublicStackResponse> => {
      if (
        !publicHandleSchema.safeParse(owner).success ||
        !publicSlugSchema.safeParse(slug).success
      )
        throw publicStackNotFound();
      const stack = await ctx.repository.getPublicStackByHandleSlug(
        owner,
        slug,
      );
      if (!stack) throw publicStackNotFound();
      const latest = stack.latestVersionId
        ? await ctx.repository.getPublicStackVersionById(stack.latestVersionId)
        : null;
      return {
        stackId: stack.stackId,
        owner: stack.ownerHandle,
        slug: stack.slug,
        displayName: stack.displayName,
        description: stack.description,
        updatedAt: stack.updatedAt,
        latest: latest
          ? { version: summary(latest), bundle: latest.bundle }
          : null,
      };
    },

    getPublicStackVersion: async (
      owner: string,
      slug: string,
      versionNumber: number,
    ): Promise<GetPublicStackVersionResponse> => {
      const stack = await ctx.repository.getPublicStackByHandleSlug(
        owner,
        slug,
      );
      if (!stack) throw publicStackNotFound();
      const version = await ctx.repository.getPublicStackVersionByNumber(
        stack.stackId,
        versionNumber,
      );
      if (!version)
        throw publicStackNotFound('Public Stack version not found.');
      return {
        owner: stack.ownerHandle,
        slug: stack.slug,
        version: summary(version),
        bundle: version.bundle,
      };
    },

    getPublicProfile: async (owner: string): Promise<PublicProfileResponse> => {
      if (!publicHandleSchema.safeParse(owner).success)
        throw publicStackNotFound('Unknown profile.');
      const ownerUserId = await ctx.repository.findHandleOwner(owner);
      if (!ownerUserId) throw publicStackNotFound('Unknown profile.');
      const profile = await ctx.repository.getProfileByHandle(owner);
      const stacks = await ctx.repository.listPublicStacksByHandle(owner);
      const listed = await Promise.all(
        stacks.map(async (stack) => {
          const latest = stack.latestVersionId
            ? await ctx.repository.getPublicStackVersionById(
                stack.latestVersionId,
              )
            : null;
          return {
            slug: stack.slug,
            displayName: stack.displayName,
            description: stack.description,
            latestVersionNumber: latest?.versionNumber ?? null,
            updatedAt: stack.updatedAt,
          };
        }),
      );
      return {
        owner,
        ...(profile?.displayName ? { displayName: profile.displayName } : {}),
        ...(profile?.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
        stacks: listed,
      };
    },
  };
};

export type PublicStackService = ReturnType<typeof createPublicStackService>;

// Re-exported for symmetry with @owner/name formatting on the client.
export { formatPublicStackRef };
