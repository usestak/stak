import { z } from 'zod';

import { contentHashSchema } from './storage.js';
import { declaredCapabilitiesSchema } from './scanner.js';

/**
 * P3 product read models + account-side write requests. These are the authenticated,
 * product-ready shapes the signed-in web (P4–P8) consumes. They expose only truthful,
 * privacy-safe fields — never filesystem paths, raw/Protected Memory, tokens, or secrets.
 */

const entryIdSchema = z.string().regex(/^skill_[A-Za-z0-9_-]{8,}$/);
const timestamp = z.iso.datetime({ offset: true });

/* ------------------------------- Skills ------------------------------- */

/**
 * Structural inability to check (P5a §5a). Reserved for EXACTLY the intrinsic properties of a
 * Skill's own restoration record that are computable with zero network I/O. A network operation
 * that did not succeed (DNS, timeout, host down, auth required/denied, transient public-stack
 * failure) is NEVER a cannot-check reason — it is `check-failed`.
 */
export const cannotCheckReasonSchema = z.enum([
  'local',
  'dirty',
  'ambiguous',
  'pinned',
]);

/**
 * Why Cloud holds no reviewable artifact for a real, found update (P5a §5a). This is a REVIEW
 * CAPABILITY fact, separate from the SOURCE fact (`sourceCheckState: 'update-available'`).
 */
export const reviewUnavailableReasonSchema = z.enum(['exceeds-review-bounds']);

/**
 * The latest CLI-reported source-check result for one Skill (P5a §5a). `not-checked` and
 * `cannot-check` are DISTINCT: the former means a checkable source simply has no current
 * CLI-reported result; the latter means the source is structurally uncheckable (Local,
 * dirty, ambiguous, pinned — computable without network access). `check-failed` is any
 * network/auth operation that did not succeed during an explicit check — never collapsed
 * into `cannot-check`.
 */
export const sourceCheckStateSchema = z.enum([
  'no-update',
  'update-available',
  'not-checked',
  'cannot-check',
  'check-failed',
]);

/**
 * Source provenance summary — a safe classification, never a raw remote, credential, or local
 * path. For a Git-backed source, `host`/`ownerRepo` are the ONLY safe display identity
 * (produced by `@stack/shared`'s `safeGitRemoteDisplay`, the one place allowed to parse a raw
 * remote) — never the remote string itself, which may embed userinfo credentials, a query
 * token, or an auth fragment. `host`/`ownerRepo` are absent when the remote could not be
 * parsed into a safe identity; the web falls back to a generic "Git source" label, never to
 * the raw string.
 */
export const skillSourceSummarySchema = z.object({
  kind: z.enum(['git', 'public-stack', 'local', 'snapshot']),
  checkable: z.boolean(),
  // A human-safe label for a non-git source (e.g. "Local"), never a path or raw remote.
  label: z.string().optional(),
  host: z.string().optional(),
  ownerRepo: z.string().optional(),
  trackedRef: z.string().optional(),
});

/** Declared-capability state (contract §7): absent = "not declared", never defaulted false. */
export const capabilityStateSchema = z.object({
  declared: z.boolean(),
  capabilities: declaredCapabilitiesSchema.optional(),
});

export const skillInstallSchema = z.object({
  machineId: z.uuid(),
  name: z.string().optional(),
  installedVersion: contentHashSchema.nullable(),
});

/**
 * One changed file inside a review artifact (P5a §5a/§7/§8). Unchanged files never appear.
 *
 * Cross-field invariants (enforced below via `.superRefine()`, not just doc comments):
 * - A binary file (`binary: true`) never carries `beforeText`/`afterText`.
 * - `kind: 'added'` has `after` present and `before` absent.
 * - `kind: 'removed'` has `before` present and `after` absent.
 * - `kind: 'modified'` has BOTH `before` and `after` present.
 */
export const reviewArtifactFileSchema = z
  .object({
    relativePath: z.string().min(1),
    kind: z.enum(['added', 'modified', 'removed']),
    binary: z.boolean(),
    before: z
      .object({
        byteSize: z.number().int().nonnegative(),
        hash: z.string().min(1),
      })
      .optional(),
    after: z
      .object({
        byteSize: z.number().int().nonnegative(),
        hash: z.string().min(1),
      })
      .optional(),
    // Present only when !binary; a binary file never carries a text preview.
    beforeText: z.string().optional(),
    afterText: z.string().optional(),
  })
  .strict()
  .superRefine((file, ctx) => {
    if (
      file.binary &&
      (file.beforeText !== undefined || file.afterText !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'A binary file must not carry beforeText/afterText.',
      });
    }
    if (file.kind === 'added') {
      if (file.after === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: "kind 'added' requires 'after' to be present.",
          path: ['after'],
        });
      }
      if (file.before !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: "kind 'added' must not include 'before'.",
          path: ['before'],
        });
      }
    }
    if (file.kind === 'removed') {
      if (file.before === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: "kind 'removed' requires 'before' to be present.",
          path: ['before'],
        });
      }
      if (file.after !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: "kind 'removed' must not include 'after'.",
          path: ['after'],
        });
      }
    }
    if (file.kind === 'modified') {
      if (file.before === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: "kind 'modified' requires 'before' to be present.",
          path: ['before'],
        });
      }
      if (file.after === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: "kind 'modified' requires 'after' to be present.",
          path: ['after'],
        });
      }
    }
  });
export type ReviewArtifactFile = z.infer<typeof reviewArtifactFileSchema>;

/**
 * One immutable, bounded review artifact (P5a §5a/§1/§2). Produced entirely by the CLI;
 * Cloud stores and serves it, verifying only `artifactPayloadHash` (the bounded payload it
 * actually holds) — never claiming to have independently recomputed `candidateContentHash`
 * (the full candidate tree hash, which Cloud never materializes).
 */
export const skillReviewArtifactSchema = z
  .object({
    reviewArtifactId: z.uuid(),
    skillId: entryIdSchema,
    approvedContentHash: contentHashSchema,
    candidateRevision: z.string().min(1),
    candidateContentHash: contentHashSchema,
    artifactPayloadHash: z.string().min(1),
    checkedAt: timestamp,
    files: z.array(reviewArtifactFileSchema).max(200),
  })
  .strict();
export type SkillReviewArtifact = z.infer<typeof skillReviewArtifactSchema>;

/**
 * CLI → Cloud upload for an update-available result (P5a §13/§16 bounds). Identical to
 * `skillReviewArtifactSchema` minus the server-assigned `reviewArtifactId`, expressed via
 * `.omit()` so the two can never drift out of sync. (`skillReviewArtifactSchema` itself
 * carries no `.superRefine()` of its own — only its nested `reviewArtifactFileSchema` items
 * do — so `.omit()` works cleanly here; Zod refuses `.omit()` only on a schema that has a
 * refinement directly attached to itself.)
 */
export const uploadSkillReviewArtifactRequestSchema =
  skillReviewArtifactSchema.omit({
    reviewArtifactId: true,
  });
export type UploadSkillReviewArtifactRequest = z.infer<
  typeof uploadSkillReviewArtifactRequestSchema
>;
export type UploadSkillReviewArtifactResponse = { reviewArtifactId: string };

/**
 * CLI → Cloud report for a NO-ARTIFACT result: no-update, cannot-check, check-failed, or an
 * update-available result for which no reviewable artifact can be produced (e.g. it exceeds
 * the V0 review bounds). An update-available result WITH an artifact goes through
 * `uploadSkillReviewArtifactRequestSchema` instead, so on this path `update-available` always
 * requires BOTH `candidateRevision` and `reviewUnavailableReason`.
 */
export const reportSkillSourceCheckRequestSchema = z
  .object({
    skillId: entryIdSchema,
    approvedContentHash: contentHashSchema,
    sourceCheckState: z.enum([
      'no-update',
      'update-available',
      'cannot-check',
      'check-failed',
    ]),
    checkedAt: timestamp,
    candidateRevision: z.string().min(1).optional(),
    reviewUnavailableReason: reviewUnavailableReasonSchema.optional(),
    cannotCheckReason: cannotCheckReasonSchema.optional(),
    // Sanitized only — never raw Git stderr, which may contain credentials/URLs.
    failureReason: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    const state = request.sourceCheckState;
    if (state === 'update-available') {
      if (request.candidateRevision === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: "An 'update-available' report requires candidateRevision.",
          path: ['candidateRevision'],
        });
      }
      if (request.reviewUnavailableReason === undefined) {
        ctx.addIssue({
          code: 'custom',
          message:
            "An 'update-available' report requires reviewUnavailableReason (an update with a reviewable artifact is uploaded via uploadSkillReviewArtifact instead).",
          path: ['reviewUnavailableReason'],
        });
      }
    } else {
      if (request.candidateRevision !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message:
            "candidateRevision is only valid when sourceCheckState is 'update-available'.",
          path: ['candidateRevision'],
        });
      }
      if (request.reviewUnavailableReason !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message:
            "reviewUnavailableReason is only valid when sourceCheckState is 'update-available'.",
          path: ['reviewUnavailableReason'],
        });
      }
    }
    if (state !== 'cannot-check' && request.cannotCheckReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          "cannotCheckReason is only valid when sourceCheckState is 'cannot-check'.",
        path: ['cannotCheckReason'],
      });
    }
    if (state !== 'check-failed' && request.failureReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          "failureReason is only valid when sourceCheckState is 'check-failed'.",
        path: ['failureReason'],
      });
    }
  });
export type ReportSkillSourceCheckRequest = z.infer<
  typeof reportSkillSourceCheckRequestSchema
>;

export const skillSummarySchema = z
  .object({
    skillId: entryIdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    approvedVersion: contentHashSchema,
    paused: z.boolean(),
    source: skillSourceSummarySchema,
    capability: capabilityStateSchema,
    sourceCheckState: sourceCheckStateSchema,
    checkedAt: timestamp.nullable(),
    // Present only when sourceCheckState === 'update-available'.
    candidateRevision: z.string().optional(),
    reviewArtifactId: z.uuid().optional(),
    // Present only when sourceCheckState === 'update-available' AND Cloud holds no reviewable
    // artifact for it (mutually exclusive with reviewArtifactId).
    reviewUnavailableReason: reviewUnavailableReasonSchema.optional(),
    // Present only when sourceCheckState === 'cannot-check'.
    cannotCheckReason: cannotCheckReasonSchema.optional(),
    // Present only when sourceCheckState === 'check-failed'.
    checkFailedReason: z.string().optional(),
    installs: z.array(skillInstallSchema),
  })
  .superRefine((summary, ctx) => {
    if (summary.sourceCheckState !== 'update-available') {
      if (summary.candidateRevision !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message:
            "candidateRevision is only valid when sourceCheckState is 'update-available'.",
          path: ['candidateRevision'],
        });
      }
      if (summary.reviewArtifactId !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message:
            "reviewArtifactId is only valid when sourceCheckState is 'update-available'.",
          path: ['reviewArtifactId'],
        });
      }
      if (summary.reviewUnavailableReason !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message:
            "reviewUnavailableReason is only valid when sourceCheckState is 'update-available'.",
          path: ['reviewUnavailableReason'],
        });
      }
    }
    if (
      summary.reviewUnavailableReason !== undefined &&
      summary.reviewArtifactId !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'reviewUnavailableReason and reviewArtifactId are mutually exclusive.',
        path: ['reviewUnavailableReason'],
      });
    }
    if (
      summary.sourceCheckState !== 'cannot-check' &&
      summary.cannotCheckReason !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          "cannotCheckReason is only valid when sourceCheckState is 'cannot-check'.",
        path: ['cannotCheckReason'],
      });
    }
    if (
      summary.sourceCheckState !== 'check-failed' &&
      summary.checkFailedReason !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          "checkFailedReason is only valid when sourceCheckState is 'check-failed'.",
        path: ['checkFailedReason'],
      });
    }
  });

export const skillsReadModelSchema = z.object({
  environmentExists: z.boolean(),
  skills: z.array(skillSummarySchema),
});

export const skillVersionHistoryEntrySchema = z.object({
  contentHash: contentHashSchema,
  environmentVersionNumber: z.number().int().positive(),
  approvedAt: timestamp,
});

export const skillDetailSchema = skillSummarySchema.extend({
  history: z.array(skillVersionHistoryEntrySchema),
  // The full artifact, only when sourceCheckState === 'update-available'; null otherwise,
  // including when bounds were exceeded (no artifact was ever produced — see contract §5a).
  reviewArtifact: skillReviewArtifactSchema.nullable(),
});

/* ------------------------------ Machines ------------------------------ */

export const machineStatusSchema = z.enum([
  'up-to-date',
  'updates-waiting',
  'checked-in',
  'never-checked-in',
]);
export const machineSummarySchema = z.object({
  machineId: z.uuid(),
  name: z.string().optional(),
  platform: z.string().optional(),
  arch: z.string().optional(),
  agentsDetected: z.array(z.string()),
  firstSeenAt: timestamp,
  lastCheckinAt: timestamp.nullable(),
  memoryBackedUp: z.boolean(),
  revoked: z.boolean(),
  status: machineStatusSchema,
  updatesWaiting: z.array(entryIdSchema),
  projectsPresent: z.number().int().nonnegative(),
});
export const machinesReadModelSchema = z.object({
  machines: z.array(machineSummarySchema),
});
export const revokeMachineRequestSchema = z
  .object({ machineId: z.uuid() })
  .strict();
export const revokeMachineResponseSchema = z.object({
  machineId: z.uuid(),
  revoked: z.literal(true),
});

/* ------------------------------ Projects ------------------------------ */

export const projectLifecycleSchema = z.enum(['active', 'archived']);
export const projectSummarySchema = z.object({
  projectId: z.string().min(1).max(100),
  name: z.string().optional(),
  lifecycle: projectLifecycleSchema,
  presentOn: z.array(z.uuid()),
  // Per-project Memory file count where derivable (Standard only); null when Protected.
  fileCount: z.number().int().nonnegative().nullable(),
  lastBackupAt: timestamp.nullable(),
});
export const projectsReadModelSchema = z.object({
  projects: z.array(projectSummarySchema),
});
export const setProjectLifecycleRequestSchema = z
  .object({
    projectId: z.string().min(1).max(100),
    lifecycle: projectLifecycleSchema,
  })
  .strict();
export const setProjectLifecycleResponseSchema = z.object({
  projectId: z.string(),
  lifecycle: projectLifecycleSchema,
});
/**
 * A Project this sync minted a FRESH `projectId` for, but that this account already owns
 * under a DIFFERENT, authoritative `projectId` for the exact same Git canonical identity —
 * Cloud refused the second row and reports the existing one here so the CLI can retire its
 * freshly-minted id and adopt the authoritative one before the next backup/check-in (never
 * leaving the local registry in a state that would just recreate the duplicate next run).
 */
export const projectReconciliationSchema = z.object({
  fromProjectId: z.string(),
  toProjectId: z.string(),
});
export const syncProjectsResponseSchema = z.object({
  ok: z.literal(true),
  reconciled: z.array(projectReconciliationSchema).optional(),
});
/**
 * CLI → cloud project DISCOVERY sync. This conveys only that a stable Project exists and its
 * safe display metadata (a name that is never a path). It carries NO lifecycle: discovery must
 * never masquerade as lifecycle intent, so a stale local machine can never silently unarchive a
 * Project the account archived from the web. Lifecycle is changed only by the explicit
 * account-side archive/unarchive write. A newly-discovered Project defaults to `active`.
 *
 * `gitCanonical`, when present, is the actual canonical Git identity (`host/owner/repo`) this
 * Project resolved to — carried explicitly, never re-derived from `name` by string-sniffing, so
 * Cloud-side canonical-identity reconciliation (never identity-by-displayName) has a real
 * identity signal to match on.
 */
export const syncProjectsRequestSchema = z
  .object({
    projects: z
      .array(
        z
          .object({
            projectId: z.string().min(1).max(100),
            name: z.string().max(200).optional(),
            gitCanonical: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(5000),
  })
  .strict();

/* ------------------------------- Memory ------------------------------- */

export const memoryModeSchema = z.enum(['standard', 'protected']);
export const recoveryMethodStateSchema = z.object({
  type: z.enum(['passkey', 'recovery-file', 'trusted-device']),
  label: z.string(),
  createdAt: timestamp,
});
export const memoryBackupSummarySchema = z.object({
  generation: z.number().int().nonnegative(),
  mode: memoryModeSchema,
  createdAt: timestamp,
});
export const memoryProjectCountSchema = z.object({
  projectId: z.string(),
  fileCount: z.number().int().nonnegative(),
});
export const memoryReadModelSchema = z.object({
  mode: memoryModeSchema.nullable(),
  latestBackupAt: timestamp.nullable(),
  backups: z.array(memoryBackupSummarySchema),
  recoveryMethods: z.array(recoveryMethodStateSchema),
  hasRecoveryMethod: z.boolean(),
  // Per-project counts are derivable only for Standard; null signals "unavailable (Protected)".
  perProject: z.array(memoryProjectCountSchema).nullable(),
});
export const deleteCloudMemoryResponseSchema = z.object({
  deletedGenerations: z.number().int().nonnegative(),
  deletedRecoveryMethods: z.number().int().nonnegative(),
  recoverable: z.literal(false),
});

/* ------------------------------- Stacks ------------------------------- */

export const ownedStackSummarySchema = z.object({
  name: z.string().min(1),
  environmentId: z.string(),
  latestVersionNumber: z.number().int().nonnegative().nullable(),
  skillCount: z.number().int().nonnegative(),
  updatedAt: timestamp.nullable(),
});
export const stacksReadModelSchema = z.object({
  owned: z.array(ownedStackSummarySchema),
});

/* ------------------------------ Activity ------------------------------ */

export const activityKindSchema = z.enum([
  'memory-backed-up',
  'machine-checked-in',
  'skill-version-approved',
  'stack-published',
]);
export const activityItemSchema = z.object({
  kind: activityKindSchema,
  at: timestamp,
  sourceId: z.string().optional(),
  label: z.string().optional(),
});
export const activityReadModelSchema = z.object({
  items: z.array(activityItemSchema),
});

/* ------------------------------ Overview ------------------------------ */

export const needsAttentionSchema = z.object({
  kind: z.enum([
    'update-available',
    'project-not-on-machine',
    'machine-stale',
    'protected-no-recovery',
  ]),
  label: z.string(),
  ref: z.string().optional(),
});
export const overviewReadModelSchema = z.object({
  viewingMachineId: z.uuid().nullable(),
  lastBackupAt: timestamp.nullable(),
  skills: z.object({
    total: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    updatesAvailable: z.number().int().nonnegative(),
  }),
  memory: z.object({
    mode: memoryModeSchema.nullable(),
    hasRecoveryMethod: z.boolean(),
  }),
  projects: z.object({
    total: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
  }),
  machines: z.object({
    total: z.number().int().nonnegative(),
    updatesWaiting: z.number().int().nonnegative(),
  }),
  needsAttention: z.array(needsAttentionSchema),
  recentActivity: z.array(activityItemSchema),
});

/* ------------------------- Skill write requests ------------------------ */

export const approveSkillVersionRequestSchema = z
  .object({
    skillId: entryIdSchema,
    reviewArtifactId: z.uuid(),
  })
  .strict();
export const setSkillPausedRequestSchema = z
  .object({ skillId: entryIdSchema, paused: z.boolean() })
  .strict();

/* -------------------------------- Types -------------------------------- */

export type CannotCheckReason = z.infer<typeof cannotCheckReasonSchema>;
export type ReviewUnavailableReason = z.infer<
  typeof reviewUnavailableReasonSchema
>;
export type SourceCheckState = z.infer<typeof sourceCheckStateSchema>;
export type SkillSourceSummary = z.infer<typeof skillSourceSummarySchema>;
export type CapabilityState = z.infer<typeof capabilityStateSchema>;
export type SkillInstall = z.infer<typeof skillInstallSchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type SkillsReadModel = z.infer<typeof skillsReadModelSchema>;
export type SkillDetail = z.infer<typeof skillDetailSchema>;
export type SkillVersionHistoryEntry = z.infer<
  typeof skillVersionHistoryEntrySchema
>;
export type MachineStatus = z.infer<typeof machineStatusSchema>;
export type MachineSummary = z.infer<typeof machineSummarySchema>;
export type MachinesReadModel = z.infer<typeof machinesReadModelSchema>;
export type RevokeMachineRequest = z.infer<typeof revokeMachineRequestSchema>;
export type RevokeMachineResponse = z.infer<typeof revokeMachineResponseSchema>;
export type ProjectLifecycle = z.infer<typeof projectLifecycleSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type ProjectsReadModel = z.infer<typeof projectsReadModelSchema>;
export type SetProjectLifecycleRequest = z.infer<
  typeof setProjectLifecycleRequestSchema
>;
export type SyncProjectsRequest = z.infer<typeof syncProjectsRequestSchema>;
export type SyncProjectsResponse = z.infer<typeof syncProjectsResponseSchema>;
export type SetProjectLifecycleResponse = z.infer<
  typeof setProjectLifecycleResponseSchema
>;
export type MemoryMode = z.infer<typeof memoryModeSchema>;
export type RecoveryMethodState = z.infer<typeof recoveryMethodStateSchema>;
export type MemoryBackupSummary = z.infer<typeof memoryBackupSummarySchema>;
export type MemoryReadModel = z.infer<typeof memoryReadModelSchema>;
export type DeleteCloudMemoryResponse = z.infer<
  typeof deleteCloudMemoryResponseSchema
>;
export type OwnedStackSummary = z.infer<typeof ownedStackSummarySchema>;
export type StacksReadModel = z.infer<typeof stacksReadModelSchema>;
export type ActivityKind = z.infer<typeof activityKindSchema>;
export type ActivityItem = z.infer<typeof activityItemSchema>;
export type ActivityReadModel = z.infer<typeof activityReadModelSchema>;
export type NeedsAttention = z.infer<typeof needsAttentionSchema>;
export type OverviewReadModel = z.infer<typeof overviewReadModelSchema>;
export type ApproveSkillVersionRequest = z.infer<
  typeof approveSkillVersionRequestSchema
>;
export type SetSkillPausedRequest = z.infer<typeof setSkillPausedRequestSchema>;
