import { createHash } from 'node:crypto';

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
  ReportSkillSourceCheckRequest,
  RevokeMachineResponse,
  SetSkillPausedRequest,
  SkillDetail,
  SkillInstall,
  SkillSourceSummary,
  SkillSummary,
  SkillsReadModel,
  StacksReadModel,
  SyncProjectsRequest,
  UploadSkillReviewArtifactRequest,
  UploadSkillReviewArtifactResponse,
} from '@stack/spec';
import {
  standardProjectCountsFromBundle,
  type RemoteMemoryBackend,
} from '@stack/memory';

import { invalidRequest, notFound, remoteConflict } from './errors.js';
import { deriveMachineState } from './machine-state.js';
import { RemoteConflict } from './repository.js';
import type {
  CloudBlobStore,
  CloudRepository,
  CloudEnvironmentVersionRecord,
  MachineStateRecord,
  ReviewArtifactFileRecord,
  SkillReviewCheckRecord,
} from './repository.js';
import type { AuthenticatedUser } from './service.js';

/**
 * Upper bound on one review-artifact text payload Cloud will accept and hold (P5a §16). The CLI
 * already refuses to build an artifact over 2 MiB of file content; this is a defensive cap on
 * the serialized payload (JSON escaping can expand text), not a second product bound.
 */
export const MAX_REVIEW_PAYLOAD_BYTES = 8 * 1024 * 1024;

const sha256Of = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

type ReviewPayloadText = { beforeText?: string; afterText?: string };

/**
 * Parse a review payload (`{ files: [{ relativePath, beforeText?, afterText? }] }`) and check it
 * against the declared metadata: every entry must name a declared, non-binary file, appear at
 * most once, and carry text only for a side the metadata says exists. Returns the text by path,
 * or null when the payload is malformed or inconsistent. Never throws.
 */
const parseReviewPayload = (
  bytes: Uint8Array,
  files: readonly ReviewArtifactFileRecord[],
): Map<string, ReviewPayloadText> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const entries = (parsed as { files?: unknown }).files;
  if (!Array.isArray(entries)) return null;
  const declared = new Map(files.map((file) => [file.relativePath, file]));
  const textByPath = new Map<string, ReviewPayloadText>();
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { relativePath, beforeText, afterText, ...extra } = entry as Record<
      string,
      unknown
    >;
    if (Object.keys(extra).length > 0) return null;
    if (typeof relativePath !== 'string') return null;
    const file = declared.get(relativePath);
    if (!file || file.binary || textByPath.has(relativePath)) return null;
    if (
      beforeText !== undefined &&
      (typeof beforeText !== 'string' || !file.before)
    )
      return null;
    if (
      afterText !== undefined &&
      (typeof afterText !== 'string' || !file.after)
    )
      return null;
    textByPath.set(relativePath, {
      ...(beforeText !== undefined ? { beforeText: beforeText as string } : {}),
      ...(afterText !== undefined ? { afterText: afterText as string } : {}),
    });
  }
  return textByPath;
};

const STALE_MACHINE_MS = 30 * 24 * 60 * 60 * 1000;

/** Optional per-project file-count deriver (Standard Memory only; never decrypts Protected). */
export type MemoryProjectCounts = (
  userId: string,
) => Promise<{ projectId: string; fileCount: number }[] | null>;

/** Default max Standard payload bytes the server will read for per-project derivation. */
export const DEFAULT_STANDARD_COUNT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The production Standard per-project deriver (P3 §2). For STANDARD Memory only, it reads the
 * authenticated user's latest Standard backup payload (bounded) and groups the manifest's
 * project-scoped items by stable Project ID — aggregate counts only, no bodies, no paths, no
 * names. For PROTECTED it returns null and NEVER reads/decrypts the ciphertext. Malformed or
 * oversized payloads fail safe (null).
 */
export const createStandardMemoryProjectCounts =
  (
    backendFor: (userId: string) => RemoteMemoryBackend,
    maxBytes: number = DEFAULT_STANDARD_COUNT_MAX_BYTES,
  ): MemoryProjectCounts =>
  async (userId) => {
    const backend = backendFor(userId);
    const profile = await backend.getProfile();
    if (profile?.privacyMode !== 'standard') return null; // never touch Protected/none
    const latest = await backend.getLatest();
    if (!latest) return null;
    const payload = await backend.getPayload(latest.backupId);
    if (payload.byteLength > maxBytes) return null; // bounded read
    return standardProjectCountsFromBundle(payload);
  };

export type ProductServiceConfig = {
  repository: CloudRepository;
  now: () => Date;
  newId: () => string;
  memoryBackendFor?: (userId: string) => RemoteMemoryBackend;
  /** Owner-scoped, content-addressed blob store holding review-artifact text payloads (P5a). */
  blobStore: CloudBlobStore;
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

/**
 * Base-bound read (P5a §5a "base-bound results"): a stored check counts ONLY while it was
 * computed against the Skill's CURRENT approved content hash. A check against any other base
 * is stale and reads as no check at all (`not-checked`) — never as a diff against the wrong base.
 */
/** A stored check, narrowed to exclude the repository-internal 'consumed' tombstone state —
 *  the only shape the public SkillSummary/SkillDetail schemas know how to represent. */
type LiveSkillReviewCheck = SkillReviewCheckRecord & {
  sourceCheckState: Exclude<
    SkillReviewCheckRecord['sourceCheckState'],
    'consumed'
  >;
};

const currentCheckOf = (
  stored: SkillReviewCheckRecord | null,
  skill: PortableLockedSkill,
): LiveSkillReviewCheck | null => {
  // 'consumed' is a repository-internal idempotency tombstone (P5a gate §2) — never a live
  // check result. Explicitly excluded here as defense in depth even though its
  // approvedContentHash (deliberately the OLD base) should already make this comparison false
  // in the overwhelming common case; this guards the one-in-2^256 coincidence where it wouldn't.
  if (!stored || stored.sourceCheckState === 'consumed') return null;
  return stored.approvedContentHash === skill.contentHash
    ? (stored as LiveSkillReviewCheck)
    : null;
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
      // The read model only ever reads the latest CLI-reported, persisted check — Cloud never
      // resolves sources itself (P5a §5a).
      const check = currentCheckOf(
        await config.repository.getSkillReviewCheck(userId, skillId),
        skill,
      );
      result.push({
        skillId,
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        approvedVersion: skill.contentHash,
        paused: skill.paused === true,
        source: sourceSummaryOf(skill),
        capability: capabilityStateOf(skill),
        sourceCheckState: check?.sourceCheckState ?? 'not-checked',
        checkedAt: check?.checkedAt ?? null,
        // State-specific fields are emitted ONLY for their own state, so a summary can never
        // violate skillSummarySchema's cross-field invariants even if a stored row is odd.
        ...(check?.sourceCheckState === 'update-available'
          ? {
              ...(check.candidateRevision
                ? { candidateRevision: check.candidateRevision }
                : {}),
              // Mutually exclusive by construction (schema-enforced): a real update is either
              // reviewable (reviewArtifactId) or not (reviewUnavailableReason), never both.
              ...(check.reviewArtifactId
                ? { reviewArtifactId: check.reviewArtifactId }
                : check.reviewUnavailableReason
                  ? { reviewUnavailableReason: check.reviewUnavailableReason }
                  : {}),
            }
          : {}),
        ...(check?.sourceCheckState === 'cannot-check' &&
        check.cannotCheckReason
          ? { cannotCheckReason: check.cannotCheckReason }
          : {}),
        ...(check?.sourceCheckState === 'check-failed' &&
        check.checkFailedReason
          ? { checkFailedReason: check.checkFailedReason }
          : {}),
        installs: installsBySkill.get(skillId) ?? [],
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  };

  /** The Skill as currently approved in the user's latest bundle, or a not-found error. */
  const requireSkill = async (
    userId: string,
    skillId: string,
  ): Promise<PortableLockedSkill> => {
    const current = await latestBundle(userId);
    const skill = current?.bundle.resolved.skills[skillId];
    if (!skill) throw notFound('skill-not-found', 'No such Skill.');
    return skill;
  };

  /**
   * Best-effort delete each id, but NEVER swallow a failure into nothing (P5a gate §1): returns
   * exactly the ids that are still pending after this attempt, so the caller can durably persist
   * them rather than lose track. Each id is independently scoped (own artifact-id-keyed blob), so
   * one failure never blocks or risks another.
   */
  const attemptCleanup = async (
    userId: string,
    ids: readonly string[],
  ): Promise<string[]> => {
    const stillPending: string[] = [];
    for (const id of ids) {
      try {
        await config.blobStore.deleteReviewPayload(userId, id);
      } catch {
        stillPending.push(id);
      }
    }
    return stillPending;
  };

  /**
   * Commit a SkillReviewCheckRecord together with a durable cleanup obligation (P5a gate §1):
   * the obligation (superseded/consumed artifact ids, plus any still-stuck from a prior attempt)
   * is written into the SAME row, in the SAME commit, that performs the supersession/consumption
   * — never as an afterthought a failed best-effort delete could silently lose. Only after that
   * commit succeeds do we attempt the actual deletions; whatever still fails stays durably
   * recorded on the row (a second, smaller write) for the next call to retry. Idempotent: deleting
   * an already-gone blob never throws from the in-memory/Supabase implementations.
   */
  const commitWithCleanup = async (
    userId: string,
    record: SkillReviewCheckRecord,
    obligations: readonly string[],
  ): Promise<void> => {
    const pending = obligations.length > 0 ? [...obligations] : undefined;
    await config.repository.putSkillReviewCheck({
      ...record,
      ...(pending ? { pendingCleanupArtifactIds: pending } : {}),
    });
    if (!pending) return;
    const stillPending = await attemptCleanup(userId, pending);
    if (stillPending.length !== pending.length)
      await config.repository.putSkillReviewCheck({
        ...record,
        ...(stillPending.length > 0
          ? { pendingCleanupArtifactIds: stillPending }
          : {}),
      });
  };

  /**
   * The full current review artifact for a Skill summary, or null. Only an update-available
   * check that is still bound to the summary's approved version yields one. File text is merged
   * in only from a payload whose bytes still hash to `artifactPayloadHash`; if the payload is
   * missing or fails that check, the artifact is returned with metadata only — never with
   * unverified text.
   */
  const reviewArtifactOf = async (
    userId: string,
    summary: SkillSummary,
  ): Promise<SkillDetail['reviewArtifact']> => {
    if (summary.sourceCheckState !== 'update-available') return null;
    const stored = await config.repository.getSkillReviewCheck(
      userId,
      summary.skillId,
    );
    if (
      !stored ||
      stored.sourceCheckState !== 'update-available' ||
      stored.approvedContentHash !== summary.approvedVersion ||
      stored.reviewArtifactId !== summary.reviewArtifactId ||
      !stored.reviewArtifactId ||
      !stored.candidateRevision ||
      !stored.candidateContentHash ||
      !stored.artifactPayloadHash
    )
      return null;
    const diffFiles = stored.diffFiles ?? [];
    const bytes = await config.blobStore.getReviewPayload(
      userId,
      stored.reviewArtifactId,
    );
    const textByPath =
      bytes && sha256Of(bytes) === stored.artifactPayloadHash
        ? (parseReviewPayload(bytes, diffFiles) ?? new Map())
        : new Map<string, ReviewPayloadText>();
    return {
      reviewArtifactId: stored.reviewArtifactId,
      skillId: summary.skillId,
      approvedContentHash: stored.approvedContentHash,
      candidateRevision: stored.candidateRevision,
      candidateContentHash: stored.candidateContentHash,
      artifactPayloadHash: stored.artifactPayloadHash,
      checkedAt: stored.checkedAt,
      files: diffFiles.map((file) => ({
        ...file,
        ...textByPath.get(file.relativePath),
      })),
    };
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
      return {
        ...summary,
        history,
        reviewArtifact: await reviewArtifactOf(user.userId, summary),
      };
    },

    /**
     * CLI → Cloud: store an update-available result and its bounded review payload (P5a §5a).
     * Cloud verifies ONLY `artifactPayloadHash` — by rehashing the exact payload bytes it is
     * about to hold. It never recomputes or vouches for `candidateContentHash` (the full
     * candidate tree hash, which Cloud never materializes); that value is the CLI's report and
     * is what an approval later records.
     */
    uploadSkillReviewArtifact: async (
      user: AuthenticatedUser,
      request: UploadSkillReviewArtifactRequest,
      payloadBytes: Uint8Array,
    ): Promise<UploadSkillReviewArtifactResponse> => {
      if (payloadBytes.byteLength > MAX_REVIEW_PAYLOAD_BYTES)
        throw invalidRequest('Review payload exceeds the size bound.');
      if (sha256Of(payloadBytes) !== request.artifactPayloadHash)
        throw invalidRequest(
          'Uploaded review payload does not match its declared hash.',
        );
      // File text is served only from the hash-verified payload, so the (unverified)
      // metadata must not carry any text of its own.
      if (
        request.files.some(
          (file) =>
            file.beforeText !== undefined || file.afterText !== undefined,
        )
      )
        throw invalidRequest(
          'Review file metadata must not carry text; text belongs in the payload.',
        );
      const paths = new Set(request.files.map((file) => file.relativePath));
      if (paths.size !== request.files.length)
        throw invalidRequest('Review file metadata lists a path twice.');
      const diffFiles: ReviewArtifactFileRecord[] = request.files.map(
        (file) => ({
          relativePath: file.relativePath,
          kind: file.kind,
          binary: file.binary,
          ...(file.before ? { before: file.before } : {}),
          ...(file.after ? { after: file.after } : {}),
        }),
      );
      if (!parseReviewPayload(payloadBytes, diffFiles))
        throw invalidRequest(
          'Review payload does not describe the declared changed files.',
        );
      const skill = await requireSkill(user.userId, request.skillId);
      if (skill.restoration.strategy !== 'reference')
        throw invalidRequest('This Skill has no checkable source to review.');
      // Base-bound: a review computed against anything but the CURRENT approved version
      // describes the wrong delta; refuse it rather than replace a current result.
      if (request.approvedContentHash !== skill.contentHash)
        throw remoteConflict(
          'The approved version changed since this check ran. Check again.',
        );
      if (request.candidateContentHash === request.approvedContentHash)
        throw invalidRequest(
          'A candidate identical to the approved version is not an update.',
        );
      const reviewArtifactId = config.newId();
      // Capture whatever artifact is current (plus any already-stuck cleanup obligation)
      // BEFORE we overwrite it, so it can be safely cleaned up only AFTER the new one is fully
      // committed (never before), and so a prior failed cleanup is never lost.
      const previous = await config.repository.getSkillReviewCheck(
        user.userId,
        request.skillId,
      );
      const obligations = [
        ...(previous?.pendingCleanupArtifactIds ?? []),
        ...(previous?.reviewArtifactId ? [previous.reviewArtifactId] : []),
      ];
      // Safe replacement order (P5a §5a): the new payload is stored first, under its OWN
      // artifact-id-keyed slot (never the prior artifact's key — collision-proof by
      // construction), then the new metadata row replaces the old one in a single write. If
      // either step fails, the previous artifact is still fully intact and remains current.
      await config.blobStore.putReviewPayload(
        user.userId,
        reviewArtifactId,
        payloadBytes,
      );
      await commitWithCleanup(
        user.userId,
        {
          userId: user.userId,
          skillId: request.skillId,
          approvedContentHash: request.approvedContentHash,
          sourceCheckState: 'update-available',
          checkedAt: request.checkedAt,
          candidateRevision: request.candidateRevision,
          candidateContentHash: request.candidateContentHash,
          reviewArtifactId,
          artifactPayloadHash: request.artifactPayloadHash,
          diffFiles,
        },
        obligations,
      );
      return { reviewArtifactId };
    },

    /** CLI → Cloud: store a no-artifact check result (no-update / cannot-check / check-failed). */
    reportSkillSourceCheck: async (
      user: AuthenticatedUser,
      request: ReportSkillSourceCheckRequest,
    ): Promise<{ ok: true }> => {
      if (
        request.cannotCheckReason !== undefined &&
        request.sourceCheckState !== 'cannot-check'
      )
        throw invalidRequest(
          'cannotCheckReason is only valid for a cannot-check result.',
        );
      if (
        request.failureReason !== undefined &&
        request.sourceCheckState !== 'check-failed'
      )
        throw invalidRequest(
          'failureReason is only valid for a check-failed result.',
        );
      if (
        request.reviewUnavailableReason !== undefined &&
        request.sourceCheckState !== 'update-available'
      )
        throw invalidRequest(
          'reviewUnavailableReason is only valid for an update-available result.',
        );
      if (
        request.sourceCheckState === 'update-available' &&
        request.reviewUnavailableReason === undefined
      )
        throw invalidRequest(
          "An 'update-available' report requires reviewUnavailableReason (an update with a reviewable artifact is uploaded via uploadSkillReviewArtifact instead).",
        );
      const skill = await requireSkill(user.userId, request.skillId);
      if (request.approvedContentHash !== skill.contentHash)
        throw remoteConflict(
          'The approved version changed since this check ran. Check again.',
        );
      // Capture whatever artifact is current (plus any already-stuck cleanup obligation)
      // BEFORE we overwrite it (this result — including a reviewable-update's absence of one —
      // supersedes it just as much as a new upload would), so nothing is lost if a prior
      // cleanup already failed once.
      const previous = await config.repository.getSkillReviewCheck(
        user.userId,
        request.skillId,
      );
      const obligations = [
        ...(previous?.pendingCleanupArtifactIds ?? []),
        ...(previous?.reviewArtifactId ? [previous.reviewArtifactId] : []),
      ];
      // Latest-only: this replaces any prior result for the Skill, including a previous
      // update-available artifact, which therefore stops being approvable.
      await commitWithCleanup(
        user.userId,
        {
          userId: user.userId,
          skillId: request.skillId,
          approvedContentHash: request.approvedContentHash,
          sourceCheckState: request.sourceCheckState,
          checkedAt: request.checkedAt,
          ...(request.cannotCheckReason
            ? { cannotCheckReason: request.cannotCheckReason }
            : {}),
          ...(request.failureReason
            ? { checkFailedReason: request.failureReason }
            : {}),
          ...(request.sourceCheckState === 'update-available'
            ? {
                ...(request.candidateRevision
                  ? { candidateRevision: request.candidateRevision }
                  : {}),
                ...(request.reviewUnavailableReason
                  ? {
                      reviewUnavailableReason: request.reviewUnavailableReason,
                    }
                  : {}),
              }
            : {}),
        },
        obligations,
      );
      return { ok: true };
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
      // Approve-by-artifact (P5a §5a): the request names ONLY an artifact id. Everything that
      // gets approved is read from Cloud's own stored record for THIS user + THIS Skill —
      // never from the client, and never by re-resolving the source (Cloud has no resolver).
      // The lookup is keyed by (userId, skillId), so another account's or another Skill's
      // artifact can never be found here; it simply fails the id match below.
      const stored = await config.repository.getSkillReviewCheck(
        user.userId,
        request.skillId,
      );
      // Idempotent replay (P5a gate §2): this EXACT artifact was already successfully
      // approved — the 'consumed' tombstone proves it. Return the same semantic success
      // WITHOUT touching current state at all: never re-commit, never re-derive, never look
      // at `skill`'s current contentHash. This is what makes a lost-response retry safe even
      // if the Skill has since moved again to a newer approval — replaying old history must
      // never roll a later approval backwards. A tombstone superseded by a LATER consumption
      // (its reviewArtifactId no longer matches) falls through to the stale-conflict check
      // below, exactly like any other superseded artifact.
      if (
        stored?.sourceCheckState === 'consumed' &&
        stored.reviewArtifactId === request.reviewArtifactId
      ) {
        // A tombstone's candidateContentHash is always set by construction (see the
        // commitWithCleanup call below) — defensive guard only, never expected to trip.
        if (!stored.candidateContentHash)
          throw remoteConflict(
            'This review is no longer current. A newer check has superseded it — review again.',
          );
        return {
          skillId: request.skillId,
          approvedVersion: stored.candidateContentHash,
          createdNew: true,
        };
      }
      if (
        !stored ||
        stored.skillId !== request.skillId ||
        stored.reviewArtifactId !== request.reviewArtifactId ||
        stored.sourceCheckState !== 'update-available'
      )
        // Unknown, superseded by a newer check (CASE B), or replaced by a no-artifact result.
        throw remoteConflict(
          'This review is no longer current. A newer check has superseded it — review again.',
        );
      // Base-bound (CASE C): the artifact describes a delta from the approved version it was
      // computed against; if the Skill's approved version has since changed, that delta no
      // longer applies.
      if (stored.approvedContentHash !== skill.contentHash)
        throw remoteConflict(
          'The approved version changed since this review was created. Review again.',
        );
      const { candidateRevision, candidateContentHash } = stored;
      if (!candidateRevision || !candidateContentHash)
        throw remoteConflict(
          'This review is incomplete and cannot be approved. Check again.',
        );
      if (skill.restoration.strategy !== 'reference')
        throw invalidRequest(
          'This Skill has no checkable source to approve a version from.',
        );
      // Record exactly the candidate the artifact was built from (its revision + the CLI's
      // reported tree hash), keeping every other reference field as it was.
      const nextSkill: PortableLockedSkill = {
        ...skill,
        contentHash: candidateContentHash,
        restoration: {
          strategy: 'reference',
          reference: {
            ...skill.restoration.reference,
            revision: candidateRevision,
            expectedContentHash: candidateContentHash,
          },
        },
      };
      const approvedVersion = await commitBundleMutation(user.userId, current, {
        [request.skillId]: nextSkill,
      });
      // Consumed tombstone (P5a gate §2), not a bare delete: durable proof of exactly what was
      // approved — skillId/reviewArtifactId/candidateContentHash/candidateRevision — so a
      // lost-response retry can be answered idempotently, WITHOUT retaining the changed-file
      // text (the review payload itself is cleaned up below, durably). `approvedContentHash`
      // deliberately stays the OLD base: the existing base-bound read-model check already makes
      // this invisible as a live "update-available" fact the instant approval advances the
      // Skill, with zero changes to that logic needed.
      await commitWithCleanup(
        user.userId,
        {
          userId: user.userId,
          skillId: request.skillId,
          approvedContentHash: stored.approvedContentHash,
          sourceCheckState: 'consumed',
          checkedAt: stored.checkedAt,
          candidateRevision,
          candidateContentHash,
          reviewArtifactId: request.reviewArtifactId,
        },
        [...(stored.pendingCleanupArtifactIds ?? []), request.reviewArtifactId],
      );
      return {
        skillId: request.skillId,
        approvedVersion: candidateContentHash,
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
            firstSeenAt: machine.firstSeenAt,
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
      const [committed, allBackupIds, methods] = await Promise.all([
        backend.listGenerations(),
        backend.listAllBackupIds(),
        backend.listRecoveryMethods(),
      ]);
      // Retire + purge EVERY backup id, including ones already retired whose payload may have
      // been orphaned by an earlier partial failure. retireGeneration is idempotent and removes
      // the payload object; if removal fails it throws, so this action reports failure (no false
      // success) and a retry re-runs safely. Recovery methods are revoked only after payloads.
      for (const backupId of allBackupIds)
        await backend.retireGeneration(backupId, config.now);
      for (const method of methods)
        await backend.revokeRecoveryMethod(method.methodId, config.now);
      return {
        deletedGenerations: committed.length,
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
      // Revoked machines are historical/audit records, never part of "active" product
      // surfaces: not selectable as viewing context, not counted, not eligible for
      // stale-machine attention. (They still appear, flagged revoked, via
      // getMachinesReadModel/listMachineStates for a Machines page's history view.)
      const activeMachines = machines.filter((m) => m.revokedAt === undefined);
      const viewing = resolveViewingMachine(activeMachines, viewingMachineId);
      const approved = approvedList(current?.bundle ?? null);
      const machineStates = activeMachines.map((m) => ({
        machine: m,
        derived: deriveMachineState(factsOf(m), approved),
      }));
      const needsAttention: NeedsAttention[] = [];
      for (const skill of skills)
        if (skill.sourceCheckState === 'update-available')
          needsAttention.push({
            kind: 'update-available',
            label: `Update available for ${skill.name}`,
            ref: skill.skillId,
          });
      // Project not present on the viewing machine — a truthful per-machine condition ONLY once
      // that machine has checked in. Before a first check-in, presence is UNKNOWN (not absent),
      // so we must not flag every project as "not on this machine".
      if (viewing && viewing.lastCheckinAt) {
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
      for (const { machine } of machineStates) {
        if (
          machine.lastCheckinAt &&
          nowMs() - new Date(machine.lastCheckinAt).getTime() >=
            STALE_MACHINE_MS
        ) {
          needsAttention.push({
            kind: 'machine-stale',
            label: `${machine.name ?? 'A machine'} hasn't checked in for 30+ days`,
            ref: machine.machineId,
          });
          continue;
        }
        // A machine that has NEVER checked in gets a grace period (a brand-new login is not
        // stale) but is not invisible forever: once authorized more than 30 days ago with
        // still no check-in, it becomes eligible for attention using firstSeenAt.
        if (
          !machine.lastCheckinAt &&
          nowMs() - new Date(machine.firstSeenAt).getTime() >= STALE_MACHINE_MS
        )
          needsAttention.push({
            kind: 'machine-stale',
            label: `${machine.name ?? 'A machine'} has never checked in since being authorized`,
            ref: machine.machineId,
          });
      }
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
            (s) => s.sourceCheckState === 'update-available',
          ).length,
        },
        memory: { mode: memory.mode, hasRecoveryMethod: memory.hasRecovery },
        projects: {
          total: projects.length,
          archived: projects.filter((p) => p.lifecycle === 'archived').length,
        },
        machines: {
          total: activeMachines.length,
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
          // Meaningful secondary metadata is the privacy mode (persisted outside ciphertext),
          // not the internal generation number. No source machine/project is inferred.
          label:
            generation.privacyMode === 'protected'
              ? 'Protected backup'
              : 'Standard backup',
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
