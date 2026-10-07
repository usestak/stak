import { createHash } from 'node:crypto';

import {
  buildReviewArtifactFiles,
  DEFAULT_REVIEW_BOUNDS,
  materializeExactRevision,
  resolveSkillSelector,
  resolveSkillSourceLatest,
} from '@stack/core';
import type { ReviewArtifactFileRecord } from '@stack/core';
import { hashSkillTreeEntries } from '@stack/shared';
import type { EnvironmentLock } from '@stack/spec';
import type {
  CloudClient,
  UploadSkillReviewArtifactFileMetadata,
} from '@stack/cloud-client';

/**
 * `stak skill check` — contact each checkable Skill's source remote and report the result to
 * Cloud (P5a §5a). This NEVER approves, installs, pauses, or resumes anything: it only resolves
 * SOURCE (what upstream resolves to now) and, when different from APPROVED, uploads a bounded
 * review artifact for a human to review later on the web. The reporter dependency is
 * intentionally narrowed to exactly the two Cloud methods this flow uses — giving it anything
 * resembling `approveSkillVersion` would make an accidental approval call a silent no-op instead
 * of a loud `TypeError`.
 */
export type SkillCheckReporter = Pick<
  CloudClient,
  'reportSkillSourceCheck' | 'uploadSkillReviewArtifact'
>;

export type SkillCheckCannotCheckReason =
  | 'local'
  | 'dirty'
  | 'ambiguous'
  | 'unreachable'
  | 'pinned';

export type SkillCheckEntryResult = {
  entryId: string;
  name: string;
  outcome: 'no-update' | 'update-available' | 'cannot-check' | 'check-failed';
  /** Present only when `outcome === 'cannot-check'`. */
  cannotCheckReason?: SkillCheckCannotCheckReason;
  /** Present only when `outcome === 'check-failed'`; always a sanitized, fixed phrase. */
  checkFailedReason?: string;
  /** Present only when `outcome === 'update-available'`. */
  exceedsBounds?: boolean;
  candidateRevision?: string;
  /** Present only when `outcome === 'update-available' && exceedsBounds === false`. */
  reviewArtifactId?: string;
};

export type SkillCheckResult = { checked: SkillCheckEntryResult[] };

/** Never the raw Git stderr (which may embed a credential-bearing URL) — always this fixed
 *  phrase, whether the ref-resolution step or the exact-revision materialization step fails. */
const UNREACHABLE_REASON = 'Could not reach the source remote.';
/** This is a deliberate, documented wire-shape decision (see Task 8's report): the V0
 *  `reportSkillSourceCheckRequestSchema` has no `update-available`-without-artifact variant, so
 *  an update that exceeds the V0 review bounds is reported through `check-failed` with this
 *  specific, distinguishable reason rather than silently becoming a generic failure. */
const EXCEEDS_BOUNDS_REASON =
  "Update exceeds STAK's V0 review limits and can't be reviewed here.";

/** Serialize ONLY the before/after text content of non-binary changed files into one canonical
 *  JSON payload — never the metadata sent to `uploadSkillReviewArtifact`, which must never carry
 *  `beforeText`/`afterText` (those are verified only via the hash of this separate payload). */
const buildPayloadBytes = (files: ReviewArtifactFileRecord[]): Uint8Array => {
  const entries = files
    .filter((f) => f.beforeText !== undefined || f.afterText !== undefined)
    .map((f) => ({
      relativePath: f.relativePath,
      ...(f.beforeText !== undefined ? { beforeText: f.beforeText } : {}),
      ...(f.afterText !== undefined ? { afterText: f.afterText } : {}),
    }));
  return new TextEncoder().encode(JSON.stringify({ files: entries }));
};

export const runSkillCheck = async (options: {
  lock: EnvironmentLock;
  selector?: string;
  workRoot: string;
  reporter: SkillCheckReporter;
  now?: () => Date;
}): Promise<SkillCheckResult> => {
  const now = options.now ?? (() => new Date());

  let entryIds: string[];
  if (options.selector !== undefined) {
    const resolved = resolveSkillSelector(options.lock, options.selector);
    entryIds = resolved.status === 'ok' ? [resolved.entryId] : [];
  } else {
    entryIds = Object.keys(options.lock.skills);
  }

  const checked: SkillCheckEntryResult[] = [];

  for (const entryId of entryIds) {
    const locked = options.lock.skills[entryId];
    if (!locked) continue;
    const { name } = locked;
    const checkedAt = now().toISOString();

    let latest;
    try {
      latest = await resolveSkillSourceLatest({ locked });
    } catch {
      await options.reporter.reportSkillSourceCheck(entryId, {
        approvedContentHash: locked.contentHash,
        sourceCheckState: 'check-failed',
        checkedAt,
        failureReason: UNREACHABLE_REASON,
      });
      checked.push({
        entryId,
        name,
        outcome: 'check-failed',
        checkFailedReason: UNREACHABLE_REASON,
      });
      continue;
    }

    if (latest.status === 'same') {
      await options.reporter.reportSkillSourceCheck(entryId, {
        approvedContentHash: locked.contentHash,
        sourceCheckState: 'no-update',
        checkedAt,
      });
      checked.push({ entryId, name, outcome: 'no-update' });
      continue;
    }

    if (latest.status === 'uncheckable') {
      await options.reporter.reportSkillSourceCheck(entryId, {
        approvedContentHash: locked.contentHash,
        sourceCheckState: 'cannot-check',
        checkedAt,
        cannotCheckReason: latest.reason,
      });
      checked.push({
        entryId,
        name,
        outcome: 'cannot-check',
        cannotCheckReason: latest.reason,
      });
      continue;
    }

    // latest.status === 'different'. `resolveSkillSourceLatest` only reports 'different' for a
    // reference-backed Skill with a tracked ref, so `restoration.strategy` is always 'reference'
    // here — but fail closed defensively rather than assume it.
    if (locked.restoration.strategy !== 'reference') {
      await options.reporter.reportSkillSourceCheck(entryId, {
        approvedContentHash: locked.contentHash,
        sourceCheckState: 'check-failed',
        checkedAt,
        failureReason: UNREACHABLE_REASON,
      });
      checked.push({
        entryId,
        name,
        outcome: 'check-failed',
        checkFailedReason: UNREACHABLE_REASON,
      });
      continue;
    }
    const { reference } = locked.restoration;

    try {
      // Sequential, not parallel: both calls shallow-fetch from the SAME remote into their own
      // throwaway temp dirs, and some Git hosting/transports serialize concurrent fetches
      // against one remote URL (and a local-path remote can race on its own lock files), so
      // this avoids a spurious failure that has nothing to do with the actual check outcome.
      const approvedTree = await materializeExactRevision({
        workRoot: options.workRoot,
        remote: reference.remote,
        revision: reference.revision,
        skillPath: reference.path,
      });
      const candidateTree = await materializeExactRevision({
        workRoot: options.workRoot,
        remote: reference.remote,
        revision: latest.sourceRevision,
        skillPath: reference.path,
      });

      const built = buildReviewArtifactFiles(
        approvedTree,
        candidateTree,
        DEFAULT_REVIEW_BOUNDS,
      );

      if (built.status === 'exceeds-bounds') {
        await options.reporter.reportSkillSourceCheck(entryId, {
          approvedContentHash: locked.contentHash,
          sourceCheckState: 'check-failed',
          checkedAt,
          failureReason: EXCEEDS_BOUNDS_REASON,
        });
        checked.push({
          entryId,
          name,
          outcome: 'update-available',
          exceedsBounds: true,
          candidateRevision: latest.sourceRevision,
        });
        continue;
      }

      const candidateContentHash = hashSkillTreeEntries(candidateTree);
      const metadataFiles: UploadSkillReviewArtifactFileMetadata[] =
        built.files.map((f) => ({
          relativePath: f.relativePath,
          kind: f.kind,
          binary: f.binary,
          ...(f.before ? { before: f.before } : {}),
          ...(f.after ? { after: f.after } : {}),
        }));
      const payloadBytes = buildPayloadBytes(built.files);
      const artifactPayloadHash = `sha256:${createHash('sha256').update(payloadBytes).digest('hex')}`;

      const uploadResult = await options.reporter.uploadSkillReviewArtifact(
        entryId,
        {
          approvedContentHash: locked.contentHash,
          candidateRevision: latest.sourceRevision,
          candidateContentHash,
          artifactPayloadHash,
          checkedAt,
          files: metadataFiles,
        },
        payloadBytes,
      );
      checked.push({
        entryId,
        name,
        outcome: 'update-available',
        exceedsBounds: false,
        candidateRevision: latest.sourceRevision,
        reviewArtifactId: uploadResult.reviewArtifactId,
      });
    } catch {
      await options.reporter.reportSkillSourceCheck(entryId, {
        approvedContentHash: locked.contentHash,
        sourceCheckState: 'check-failed',
        checkedAt,
        failureReason: UNREACHABLE_REASON,
      });
      checked.push({
        entryId,
        name,
        outcome: 'check-failed',
        checkFailedReason: UNREACHABLE_REASON,
      });
    }
  }

  return { checked };
};
