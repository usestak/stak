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

/** Update-check outcome; `cannot-check` is NEVER collapsed into `no-update`. */
export const skillUpdateStatusSchema = z.enum([
  'no-update',
  'update-available',
  'cannot-check',
]);

/** Source provenance summary — a safe classification, never a path or remote credential. */
export const skillSourceSummarySchema = z.object({
  kind: z.enum(['git', 'public-stack', 'local', 'snapshot']),
  checkable: z.boolean(),
  // A human-safe label (e.g. a repo+ref or `@owner/slug`), never a local path.
  label: z.string().optional(),
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

export const skillSummarySchema = z.object({
  skillId: entryIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  approvedVersion: contentHashSchema,
  paused: z.boolean(),
  source: skillSourceSummarySchema,
  capability: capabilityStateSchema,
  updateStatus: skillUpdateStatusSchema,
  candidateVersion: z.string().optional(),
  installs: z.array(skillInstallSchema),
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
export const skillFileSchema = z.object({
  relativePath: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
});
export const skillDiffFileSchema = z.object({
  relativePath: z.string().min(1),
  kind: z.enum(['added', 'modified', 'removed']),
});
export const skillDetailSchema = skillSummarySchema.extend({
  history: z.array(skillVersionHistoryEntrySchema),
  files: z.array(skillFileSchema).nullable(),
  diff: z
    .object({
      sourceRevision: z.string(),
      candidateVersion: z.string(),
      files: z.array(skillDiffFileSchema),
    })
    .nullable(),
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
export const syncProjectsResponseSchema = z.object({ ok: z.literal(true) });
/**
 * CLI → cloud project DISCOVERY sync. This conveys only that a stable Project exists and its
 * safe display metadata (a name that is never a path). It carries NO lifecycle: discovery must
 * never masquerade as lifecycle intent, so a stale local machine can never silently unarchive a
 * Project the account archived from the web. Lifecycle is changed only by the explicit
 * account-side archive/unarchive write. A newly-discovered Project defaults to `active`.
 */
export const syncProjectsRequestSchema = z
  .object({
    projects: z
      .array(
        z
          .object({
            projectId: z.string().min(1).max(100),
            name: z.string().max(200).optional(),
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
    // The exact immutable candidate the user reviewed; a stale candidate is rejected.
    candidateContentHash: contentHashSchema,
    candidateRevision: z.string().min(1),
  })
  .strict();
export const setSkillPausedRequestSchema = z
  .object({ skillId: entryIdSchema, paused: z.boolean() })
  .strict();

/* -------------------------------- Types -------------------------------- */

export type SkillUpdateStatus = z.infer<typeof skillUpdateStatusSchema>;
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
