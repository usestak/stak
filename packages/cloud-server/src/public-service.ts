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
  publicSlugTaken,
  publicStackConflict,
  publicStackNotFound,
  publicationNotEligible,
} from './errors.js';
import {
  PublicStackConflict,
  type CloudBlobStore,
  type CloudRepository,
  type PublicStackRepository,
  type PublicStackVersionRecord,
} from './repository.js';
import type { AuthenticatedUser } from './service.js';

const MAX_REQUIREMENTS = 500;

export type PublicServiceContext = {
  repository: CloudRepository & PublicStackRepository;
  blobStore: CloudBlobStore;
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

      // Hybrid Public Skill Portability — the ONE place every publish path converges
      // (named-Stack publish, single-Skill share, and the legacy anonymous CLI
      // `stack publish <arg>` path all end up here), so this is the single place the
      // "every snapshot-backed requirement must have real public bytes before commit"
      // invariant is enforced — never duplicated per caller, never skippable.
      for (const requirement of bundle.requirements) {
        if (requirement.restoration.strategy === 'snapshot') {
          await ensurePublicSnapshotUploaded(
            ctx.blobStore,
            user.userId,
            requirement.restoration.contentHash,
            requirement.name,
          );
        } else {
          // Legacy reference-only publication path (pre-snapshot-first clients). Still
          // supported unchanged.
          const verdict = inspectPublicSourceRemote(
            requirement.restoration.reference.remote,
          );
          if (!verdict.safe)
            throw publicationNotEligible(
              `Skill ${requirement.name} cannot be published: ${verdict.reason}`,
            );
        }
        // Snapshot-first publication (both branches above): Git provenance survives as
        // `preferredSource`/`observedSources` regardless of restoration strategy, so an
        // unsafe remote embedded there is just as exposable as one that used to live only
        // inside `restoration.reference` — this is the server-side authoritative check, so
        // it must not trust the client to have already run `buildPublicStackBundle`'s copy.
        for (const source of [
          requirement.preferredSource,
          ...requirement.observedSources,
        ]) {
          if (source?.type !== 'git' || !source.remote) continue;
          const verdict = inspectPublicSourceRemote(source.remote);
          if (!verdict.safe)
            throw publicationNotEligible(
              `Skill ${requirement.name} cannot be published: ${verdict.reason}`,
            );
        }
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
        if (existing) {
          // Reactivate (spec final lifecycle pass §10): an idempotent retry of a publish
          // must also restore visibility if the share had been unpublished in the meantime —
          // a no-op when already active.
          await ctx.repository.reactivatePublicStack(
            user.userId,
            slug,
            ctx.nowIso(),
          );
          return {
            owner: handle,
            slug,
            stackId: existing.stackId,
            version: summary(existing),
            url: url(handle, slug),
            createdNew: false,
          };
        }
      }

      // No-op: latest already carries this exact version hash. Still reactivates (§10) —
      // publishing byte-identical content after an unpublish is how the owner says "turn
      // this back on," and must not be rejected just because nothing in the bundle changed.
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
        if (latest && latest.versionHash === bundle.stack.versionHash) {
          await ctx.repository.reactivatePublicStack(
            user.userId,
            slug,
            ctx.nowIso(),
          );
          return {
            owner: handle,
            slug,
            stackId: latest.stackId,
            version: summary(latest),
            url: url(handle, slug),
            createdNew: false,
          };
        }
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
      // Reactivate (§10): a changed-content republish (version 2+) must also turn the share
      // back on if it had been unpublished — no-op when already active.
      await ctx.repository.reactivatePublicStack(
        user.userId,
        slug,
        ctx.nowIso(),
      );
      return {
        owner: handle,
        slug,
        stackId: outcome.stack.stackId,
        version: summary(outcome.version),
        url: url(handle, slug),
        createdNew: outcome.createdNew,
      };
    },

    /** Owner-only, idempotent (§6): deactivates the public share at `slug`. Never deletes or
     *  mutates any version; the private source (named Stack/Skill) and `main` are untouched —
     *  this function only ever writes to `public_stacks.unpublished_at`. */
    unpublishPublicStack: async (
      user: AuthenticatedUser,
      request: { slug: string },
    ): Promise<void> => {
      await ctx.repository.unpublishPublicStack(
        user.userId,
        request.slug,
        ctx.nowIso(),
      );
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
      // Active-share rule (§5): an unpublished share behaves exactly like one that never
      // existed — same not-found response, no leak of "this was once published."
      if (!stack || stack.unpublishedAt !== null) throw publicStackNotFound();
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
      if (!stack || stack.unpublishedAt !== null) throw publicStackNotFound();
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

    /**
     * Serve an immutable public Skill snapshot's bytes (Hybrid Public Skill Portability).
     * The application-layer authorization boundary, not a bucket ACL: bytes are only ever
     * returned after confirming `contentHash` is actually one of THIS exact published,
     * currently-active version's own requirements — an unpublished Stack, a wrong version,
     * or a contentHash that simply isn't referenced there all fail identically (not-found),
     * so guessing a hash can never reach either an unpublished snapshot or an unrelated
     * owner-private one (which lives in a structurally separate, never-public namespace).
     */
    getPublicSkillSnapshot: async (
      owner: string,
      slug: string,
      versionNumber: number,
      contentHash: string,
    ): Promise<Uint8Array> => {
      const stack = await ctx.repository.getPublicStackByHandleSlug(
        owner,
        slug,
      );
      if (!stack || stack.unpublishedAt !== null) throw publicStackNotFound();
      const version = await ctx.repository.getPublicStackVersionByNumber(
        stack.stackId,
        versionNumber,
      );
      if (!version)
        throw publicStackNotFound('Public Stack version not found.');
      const belongs = version.bundle.requirements.some(
        (requirement) =>
          requirement.restoration.strategy === 'snapshot' &&
          requirement.restoration.contentHash === contentHash,
      );
      if (!belongs) throw publicStackNotFound('Snapshot not found.');
      const bytes = await ctx.blobStore.getPublished(contentHash);
      if (!bytes) throw publicStackNotFound('Snapshot not found.');
      return bytes;
    },

    getPublicProfile: async (owner: string): Promise<PublicProfileResponse> => {
      if (!publicHandleSchema.safeParse(owner).success)
        throw publicStackNotFound('Unknown profile.');
      const ownerUserId = await ctx.repository.findHandleOwner(owner);
      if (!ownerUserId) throw publicStackNotFound('Unknown profile.');
      const profile = await ctx.repository.getProfileByHandle(owner);
      // Active-share rule (§5): the public listing/discovery surface excludes anything
      // unpublished — `listPublicStacksByHandle` itself stays unfiltered because internal
      // bookkeeping (re-share/re-publish identity lookup) needs to find an inactive share too.
      const stacks = (
        await ctx.repository.listPublicStacksByHandle(owner)
      ).filter((stack) => stack.unpublishedAt === null);
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
            kind: latest?.bundle.stack.kind ?? 'stack',
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

/**
 * Slug-ownership invariant (spec P10 final lifecycle pass §11/§12), shared by named-Stack and
 * Skill publishing so there is exactly one place this is enforced: a public slug stays bound
 * to whichever private source first claimed it, forever — unpublishing never frees it for a
 * DIFFERENT source belonging to the same owner, and a source that already has a bound slug
 * can never change it (slug stability once published). `currentlyBoundSlug` is whatever the
 * CALLER already knows is its own binding (`user_stacks.publishedSlug`, or the Skill-share
 * lookup's existing match) — null means "this source has never published."
 */
export const guardPublicSlugClaim = async (
  repository: PublicStackRepository,
  userId: string,
  requestedSlug: string,
  currentlyBoundSlug: string | null,
): Promise<void> => {
  if (currentlyBoundSlug === requestedSlug) return; // continuing its own identity
  if (currentlyBoundSlug !== null)
    throw publicSlugTaken(
      "This can't be republished under a different public link once published — unpublish it first if you need a different one.",
    );
  const existing = await repository.getPublicStackByOwner(
    userId,
    requestedSlug,
  );
  if (existing)
    throw publicSlugTaken(
      `The public link "${requestedSlug}" is already used by another shared Skill or Stack in your account.`,
    );
};

/**
 * Ensure a Skill's content is copied into the public, content-addressed snapshot namespace
 * before a publish naming it completes (Hybrid Public Skill Portability) — shared by
 * named-Stack and Skill publishing so there is exactly one upload path. Deliberately a
 * publish-time I/O step, not part of `assessSkillShareEligibility` (which stays pure): the
 * owner must have already pushed this exact content to Cloud (`stak push`) for bytes to
 * exist at all. Idempotent/deduped — a `contentHash` already present in the public namespace
 * (from an earlier publish, by this owner or republished content that happens to hash the
 * same) is never re-uploaded.
 */
export const ensurePublicSnapshotUploaded = async (
  blobStore: CloudBlobStore,
  ownerUserId: string,
  contentHash: string,
  skillName: string,
): Promise<void> => {
  if (await blobStore.hasPublished(contentHash)) return;
  const bytes = await blobStore.get(ownerUserId, contentHash);
  if (!bytes)
    throw publicationNotEligible(
      `${skillName}'s content hasn't been uploaded to STAK Cloud yet. Run \`stak push\` first, then try sharing again.`,
    );
  await blobStore.putPublished(contentHash, bytes);
};

// Re-exported for symmetry with @owner/name formatting on the client.
export { formatPublicStackRef };
