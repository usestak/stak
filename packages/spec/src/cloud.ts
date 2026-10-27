import { z } from 'zod';

import { environmentManifestSchema } from './environment.js';
import { skillSourceSchema, skillMetadataSchema } from './scanner.js';
import {
  contentHashSchema,
  referenceRestorationSchema,
  snapshotReasonSchema,
} from './storage.js';
import { requirementOriginSchema } from './stack.js';

const entryIdSchema = z.string().regex(/^skill_[A-Za-z0-9_-]{8,}$/);

/**
 * Cloud-neutral restoration. A local snapshot restoration references a
 * Machine-local `snap_...` id; the cloud form drops that id and keeps only the
 * portable content hash. Reference restoration is already portable.
 */
export const portableSnapshotRestorationSchema = z.object({
  strategy: z.literal('snapshot'),
  contentHash: contentHashSchema,
  reason: snapshotReasonSchema,
});
export const portableRestorationStrategySchema = z.discriminatedUnion(
  'strategy',
  [referenceRestorationSchema, portableSnapshotRestorationSchema],
);

export const portableLockedSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  contentHash: contentHashSchema,
  metadata: skillMetadataSchema.optional(),
  preferredSource: skillSourceSchema.optional(),
  observedSources: z.array(skillSourceSchema),
  restoration: portableRestorationStrategySchema,
  origins: z.array(requirementOriginSchema).optional(),
  // Desired pause state (P2) rides the pushed Environment so the web can show it (P3) and
  // account-side pause/resume writes round-trip. Optional/back-compat: absent = active, so
  // pre-P2 bundles are unchanged and the Environment digest is unaffected unless a Skill is
  // actually paused.
  paused: z.boolean().optional(),
});

export const portableEnvironmentResolutionSchema = z.object({
  schemaVersion: z.literal(1),
  skills: z.record(entryIdSchema, portableLockedSkillSchema),
});

export const portableStackRequirementSchema = z.object({
  id: z.string().regex(/^req_[A-Za-z0-9_-]{8,}$/),
  name: z.string().min(1),
  requirement: z.enum(['required', 'optional']),
  contentHash: contentHashSchema,
  metadata: skillMetadataSchema,
  restoration: portableRestorationStrategySchema,
  observedSources: z.array(skillSourceSchema),
  preferredSource: skillSourceSchema.optional(),
  originStackName: z.string().min(1),
});
export const portableImportedStackVersionSchema = z.object({
  schemaVersion: z.literal(1),
  stackId: z.string().regex(/^stack_[A-Za-z0-9_-]{8,}$/),
  name: z.string().min(1),
  description: z.string().min(1),
  versionHash: contentHashSchema,
  requirements: z.array(portableStackRequirementSchema),
  inheritedStacks: z.array(
    z.object({ name: z.string(), versionHash: contentHashSchema }),
  ),
  skippedOptional: z.array(
    z.object({
      stackName: z.string().min(1),
      path: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
});

/**
 * A distinct immutable content artifact that must exist in STAK Cloud's
 * private blob store for every Skill version included in a pushed
 * Environment, regardless of that Skill's preferred private restoration
 * strategy (snapshot or Git reference). This is separate from restoration
 * metadata: a Git-backed Skill can keep `restoration.strategy === 'reference'`
 * while its content bytes are still uploaded here so public, portable
 * publication never depends on Git being reachable.
 */
export const cloudContentUploadRequirementSchema = z.object({
  contentHash: contentHashSchema,
});

/**
 * `contentUploadRequirements` is derived, non-durable state: every entry is just a
 * resolved Skill or imported-Stack requirement's own `contentHash`, recomputable at
 * any time from `resolved`/`importedStackVersions`. It exists purely as a push-time
 * worklist (which blobs need uploading) — it carries no information a stored
 * Environment version needs to be reconstructed. Exported so every reader of an
 * already-parsed bundle (not just the schema's own transform below) can rebuild it
 * the same way if ever needed.
 */
export const deriveContentUploadRequirements = (
  resolved: PortableEnvironmentResolution,
  importedStackVersions: PortableImportedStackVersion[],
): CloudContentUploadRequirement[] => {
  const hashes = new Set<string>();
  for (const skill of Object.values(resolved.skills))
    hashes.add(skill.contentHash);
  for (const version of importedStackVersions)
    for (const requirement of version.requirements)
      hashes.add(requirement.contentHash);
  return [...hashes]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((contentHash) => ({ contentHash }));
};

/**
 * `contentUploadRequirements` was introduced (as a rename of the removed
 * `snapshotRequirements` field) after STAK Cloud already held Environment versions
 * pushed by older CLI releases, which never wrote it — immutable historical rows
 * that must stay readable forever. Since the field is derivable from `resolved` and
 * `importedStackVersions` (see `deriveContentUploadRequirements`), parsing tolerates
 * its absence and fills it in here, so `CloudEnvironmentBundle` (the schema's
 * inferred, POST-transform type) always has a complete array for every reader —
 * nothing downstream needs to special-case a legacy bundle. This never rewrites the
 * stored row itself; it only normalizes the in-memory value after a read.
 */
export const cloudEnvironmentBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    environment: environmentManifestSchema,
    resolved: portableEnvironmentResolutionSchema,
    importedStackVersions: z.array(portableImportedStackVersionSchema),
    contentUploadRequirements: z
      .array(cloudContentUploadRequirementSchema)
      .optional(),
    digest: contentHashSchema,
  })
  .transform((bundle) => ({
    ...bundle,
    contentUploadRequirements:
      bundle.contentUploadRequirements ??
      deriveContentUploadRequirements(
        bundle.resolved,
        bundle.importedStackVersions,
      ),
  }));

/* -------------------------------------------------------------------------- */
/* Cloud API DTOs (versioned under /api/v1)                                   */
/* -------------------------------------------------------------------------- */

export const cloudMachineDescriptorSchema = z.object({
  machineId: z.uuid(),
  platform: z.string().min(1),
  arch: z.string().min(1),
});

export const cliAuthStartRequestSchema = z.object({
  machine: cloudMachineDescriptorSchema.optional(),
  label: z.string().min(1).max(120).optional(),
  clientVersion: z.string().min(1).max(120).optional(),
});
export const cliAuthStartResponseSchema = z.object({
  sessionId: z.uuid(),
  userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  deviceSecret: z.string().min(1),
  verificationUri: z.string().min(1),
  verificationUriComplete: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  intervalMs: z.number().int().positive(),
});

export const cliAuthTokenRequestSchema = z.object({
  deviceSecret: z.string().min(1),
});
export const cliAuthTokenResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('slow_down') }),
  z.object({ status: z.literal('denied') }),
  z.object({ status: z.literal('expired') }),
  z.object({
    status: z.literal('approved'),
    token: z.string().min(1),
    tokenId: z.uuid(),
    user: z.object({
      userId: z.uuid(),
      githubUsername: z.string().optional(),
      displayName: z.string().optional(),
      avatarUrl: z.string().optional(),
    }),
  }),
]);

export const cliAuthApproveRequestSchema = z.object({
  userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
});
export const cliAuthApproveResponseSchema = z.object({
  approved: z.literal(true),
});

export const meResponseSchema = z.object({
  userId: z.uuid(),
  githubUsername: z.string().optional(),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
  handle: z.string().optional(),
});

export const remoteEnvironmentVersionSchema = z.object({
  versionId: z.uuid(),
  versionNumber: z.number().int().positive(),
  digest: contentHashSchema,
  createdAt: z.iso.datetime({ offset: true }),
});
export const getEnvironmentResponseSchema = z.object({
  environmentId: z.uuid(),
  name: z.string().min(1),
  latest: z
    .object({
      version: remoteEnvironmentVersionSchema,
      bundle: cloudEnvironmentBundleSchema,
    })
    .nullable(),
});

export const commitEnvironmentVersionRequestSchema = z.object({
  bundle: cloudEnvironmentBundleSchema,
  expectedLatestVersionId: z.uuid().nullable(),
  machineId: z.uuid().optional(),
  idempotencyKey: z.uuid().optional(),
});
export const commitEnvironmentVersionResponseSchema = z.object({
  environmentId: z.uuid(),
  name: z.string().min(1),
  version: remoteEnvironmentVersionSchema,
  createdNew: z.boolean(),
});

export const prepareSnapshotRequestSchema = z.object({
  contentHash: contentHashSchema,
  archiveHash: contentHashSchema,
  byteSize: z.number().int().nonnegative(),
});
export const prepareSnapshotResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('exists') }),
  z.object({
    status: z.literal('upload'),
    uploadTicket: z.string().min(1),
  }),
]);
export const finalizeSnapshotRequestSchema = z.object({
  contentHash: contentHashSchema,
  archiveHash: contentHashSchema,
  byteSize: z.number().int().nonnegative(),
  uploadTicket: z.string().min(1),
});
export const finalizeSnapshotResponseSchema = z.object({
  contentHash: contentHashSchema,
  stored: z.literal(true),
});
export const snapshotDownloadResponseSchema = z.object({
  contentHash: contentHashSchema,
  archiveHash: contentHashSchema,
  byteSize: z.number().int().nonnegative(),
  downloadTicket: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/* Machine-local sync metadata (never portable, never uploaded)               */
/* -------------------------------------------------------------------------- */

export const environmentSyncStateSchema = z.object({
  remoteEnvironmentId: z.uuid(),
  lastSyncedVersionId: z.uuid(),
  lastSyncedDigest: contentHashSchema,
  syncedAt: z.iso.datetime({ offset: true }),
  /** Content hashes this Machine's last push confirmed are stored in Cloud (uploaded or
   *  already present). Snapshots are never deleted, so the next push skips re-checking them. */
  confirmedContentHashes: z.array(contentHashSchema).optional(),
});
export const machineSyncStateSchema = z.object({
  schemaVersion: z.literal(1),
  environments: z.record(z.string().min(1), environmentSyncStateSchema),
});

/* -------------------------------------------------------------------------- */
/* Machine check-in (Phase P1)                                                */
/*                                                                            */
/* The CLI reports machine state best-effort during user-run operations (no   */
/* daemon). The payload is PRESENCE ONLY: project entries carry {projectId,    */
/* present} and NEVER a path (absolute or home-relative), and no Memory        */
/* content is ever included. `.strict()` rejects any unexpected field (e.g. a  */
/* sneaked-in path), which the no-leak tests rely on.                          */
/* -------------------------------------------------------------------------- */

export const machineCheckinSkillSchema = z
  .object({
    skillId: z.string().min(1).max(300),
    installedVersion: z.string().min(1).max(100),
  })
  .strict();

export const machineCheckinProjectSchema = z
  .object({
    projectId: z.string().min(1).max(100),
    present: z.boolean(),
  })
  .strict();

export const machineCheckinRequestSchema = z
  .object({
    machineId: z.uuid(),
    name: z.string().min(1).max(200).optional(),
    platform: z.string().min(1).max(100).optional(),
    arch: z.string().min(1).max(50).optional(),
    agentsDetected: z.array(z.string().min(1).max(50)).max(20).optional(),
    memoryBackedUp: z.boolean(),
    skills: z.array(machineCheckinSkillSchema).max(2000),
    projects: z.array(machineCheckinProjectSchema).max(2000),
  })
  .strict();
export const machineCheckinResponseSchema = z.object({ ok: z.literal(true) });

export const machineStateSchema = z.object({
  machineId: z.uuid(),
  name: z.string().optional(),
  platform: z.string().optional(),
  arch: z.string().optional(),
  agentsDetected: z.array(z.string()),
  firstSeenAt: z.iso.datetime({ offset: true }),
  lastCheckinAt: z.iso.datetime({ offset: true }).nullable(),
  memoryBackedUp: z.boolean(),
  skills: z.array(machineCheckinSkillSchema),
  projects: z.array(machineCheckinProjectSchema),
});
export const listMachinesResponseSchema = z.object({
  machines: z.array(machineStateSchema),
});

export const cloudErrorCodeSchema = z.enum([
  'not-authenticated',
  'authentication-expired',
  'cloud-unauthorized',
  'remote-environment-not-found',
  'remote-environment-conflict',
  'snapshot-not-found',
  'snapshot-upload-failed',
  'snapshot-integrity-mismatch',
  'cloud-bundle-invalid',
  'cloud-version-commit-failed',
  'public-stack-not-found',
  'public-stack-conflict',
  'publication-not-eligible',
  'invalid-slug',
  'handle-unavailable',
  'invalid-request',
  'not-found',
  // P3 product resource codes (404 / stale-review 409 is remote-environment-conflict).
  'skill-not-found',
  'machine-not-found',
  'project-not-found',
  'stale-candidate',
  'memory-not-found',
  'memory-conflict',
  'memory-too-large',
  'memory-integrity',
  'memory-not-protected',
  'memory-session-consumed',
  'memory-session-expired',
  'memory-no-envelope',
  'memory-not-configured',
  // Task 13 fix round: the server refuses an old-format (`stack-mem-bundle-v1`)
  // generation once the account's latest is v2 (spec §9.3/A.5).
  'memory-incompatible-format',
  // Task 13 fix round 4: a create naming a `replicaOf` that is malformed or
  // fails the server's verification (`assertCreateGenerationAllowed`).
  'memory-invalid-replica',
  // P10B named Stacks.
  'user-stack-not-found',
  'user-stack-conflict',
  'user-stack-name-conflict',
  // P10 final lifecycle pass: public sharing identity collisions + unpublish.
  'public-slug-taken',
]);
export const cloudErrorResponseSchema = z.object({
  error: z.object({
    code: cloudErrorCodeSchema,
    message: z.string(),
  }),
});

export type PortableRestorationStrategy = z.infer<
  typeof portableRestorationStrategySchema
>;
export type PortableLockedSkill = z.infer<typeof portableLockedSkillSchema>;
export type PortableEnvironmentResolution = z.infer<
  typeof portableEnvironmentResolutionSchema
>;
export type PortableImportedStackVersion = z.infer<
  typeof portableImportedStackVersionSchema
>;
export type CloudContentUploadRequirement = z.infer<
  typeof cloudContentUploadRequirementSchema
>;
export type CloudEnvironmentBundle = z.infer<
  typeof cloudEnvironmentBundleSchema
>;
export type CloudMachineDescriptor = z.infer<
  typeof cloudMachineDescriptorSchema
>;
export type CliAuthStartRequest = z.infer<typeof cliAuthStartRequestSchema>;
export type CliAuthStartResponse = z.infer<typeof cliAuthStartResponseSchema>;
export type CliAuthTokenRequest = z.infer<typeof cliAuthTokenRequestSchema>;
export type CliAuthTokenResponse = z.infer<typeof cliAuthTokenResponseSchema>;
export type CliAuthApproveRequest = z.infer<typeof cliAuthApproveRequestSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type RemoteEnvironmentVersion = z.infer<
  typeof remoteEnvironmentVersionSchema
>;
export type GetEnvironmentResponse = z.infer<
  typeof getEnvironmentResponseSchema
>;
export type CommitEnvironmentVersionRequest = z.infer<
  typeof commitEnvironmentVersionRequestSchema
>;
export type CommitEnvironmentVersionResponse = z.infer<
  typeof commitEnvironmentVersionResponseSchema
>;
export type PrepareSnapshotRequest = z.infer<
  typeof prepareSnapshotRequestSchema
>;
export type PrepareSnapshotResponse = z.infer<
  typeof prepareSnapshotResponseSchema
>;
export type FinalizeSnapshotRequest = z.infer<
  typeof finalizeSnapshotRequestSchema
>;
export type FinalizeSnapshotResponse = z.infer<
  typeof finalizeSnapshotResponseSchema
>;
export type SnapshotDownloadResponse = z.infer<
  typeof snapshotDownloadResponseSchema
>;
export type CloudErrorCode = z.infer<typeof cloudErrorCodeSchema>;
export type CloudErrorResponse = z.infer<typeof cloudErrorResponseSchema>;
export type EnvironmentSyncState = z.infer<typeof environmentSyncStateSchema>;
export type MachineSyncState = z.infer<typeof machineSyncStateSchema>;
export type MachineCheckinSkill = z.infer<typeof machineCheckinSkillSchema>;
export type MachineCheckinProject = z.infer<typeof machineCheckinProjectSchema>;
export type MachineCheckinRequest = z.infer<typeof machineCheckinRequestSchema>;
export type MachineCheckinResponse = z.infer<
  typeof machineCheckinResponseSchema
>;
export type MachineState = z.infer<typeof machineStateSchema>;
export type ListMachinesResponse = z.infer<typeof listMachinesResponseSchema>;
