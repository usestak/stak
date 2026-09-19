import { z } from 'zod';

import {
  scanDiagnosticSchema,
  scannedRootSchema,
  skillLocationSchema,
  skillMetadataSchema,
  skillRootKindSchema,
  skillScopeSchema,
  skillSourceSchema,
} from './scanner.js';
import {
  contentHashSchema,
  localContentRecordSchema,
  restorationStrategySchema,
  storeVerificationSchema,
} from './storage.js';
import {
  environmentStackLayerSchema,
  requirementOriginSchema,
} from './stack.js';

const timestampSchema = z.iso.datetime({ offset: true });
const entryIdSchema = z.string().regex(/^skill_[A-Za-z0-9_-]{8,}$/);

export const machineIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  machineId: z.uuid(),
  createdAt: timestampSchema,
  platform: z.string().min(1),
  arch: z.string().min(1),
});

export const environmentSkillEntrySchema = z.object({
  id: entryIdSchema,
  name: z.string().min(1),
  requirement: z.enum(['required', 'optional']),
});

export const environmentManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  skills: z.array(environmentSkillEntrySchema),
  stacks: z.array(environmentStackLayerSchema),
  overrides: z.record(z.string(), z.unknown()),
});

export const lockedSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  contentHash: contentHashSchema,
  metadata: skillMetadataSchema.optional(),
  preferredSource: skillSourceSchema.optional(),
  observedSources: z.array(skillSourceSchema),
  localContent: localContentRecordSchema,
  restoration: restorationStrategySchema,
  origins: z.array(requirementOriginSchema).optional(),
});

export const environmentLockSchema = z.object({
  schemaVersion: z.literal(1),
  resolvedAt: timestampSchema,
  skills: z.record(entryIdSchema, lockedSkillSchema),
});

export const baselineLocationSchema = skillLocationSchema.extend({
  contentHash: contentHashSchema,
});

export const machineEnvironmentBaselineSchema = z.object({
  schemaVersion: z.literal(1),
  machineId: z.uuid(),
  environment: z.string().min(1),
  capturedAt: timestampSchema,
  skills: z.record(
    entryIdSchema,
    z.object({
      contentHash: contentHashSchema,
      locations: z.array(baselineLocationSchema),
    }),
  ),
});

export const skillStatusSchema = z.object({
  entryId: entryIdSchema,
  name: z.string(),
  state: z.enum(['satisfied', 'modified', 'missing', 'uncertain']),
  desiredHash: contentHashSchema,
  currentHash: contentHashSchema.optional(),
  desiredSource: skillSourceSchema.optional(),
  currentSource: skillSourceSchema.optional(),
  baselineLocations: z.array(baselineLocationSchema),
  currentLocations: z.array(baselineLocationSchema),
  uncertaintyRoots: z.array(scannedRootSchema),
  preservation: storeVerificationSchema,
  restorationStrategy: z.enum(['reference', 'snapshot']),
  origins: z.array(requirementOriginSchema).optional(),
});

export const untrackedSkillSchema = z.object({
  name: z.string(),
  contentHash: contentHashSchema,
  source: skillSourceSchema,
  locations: z.array(baselineLocationSchema),
});

export const invalidDiscoveredSkillSchema = z.object({
  contentHash: contentHashSchema,
  name: z.string().optional(),
  locations: z.array(baselineLocationSchema),
  diagnostics: z.array(scanDiagnosticSchema),
});

export const placementDriftSchema = z.object({
  entryId: entryIdSchema,
  name: z.string(),
  kind: z.enum(['added', 'removed', 'changed']),
  rootKind: skillRootKindSchema,
  scope: skillScopeSchema,
  path: z.string(),
  previous: baselineLocationSchema.optional(),
  current: baselineLocationSchema.optional(),
});

export const environmentStatusSummarySchema = z.object({
  satisfied: z.number().int().nonnegative(),
  modified: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  uncertain: z.number().int().nonnegative(),
  untracked: z.number().int().nonnegative(),
  placementAdded: z.number().int().nonnegative(),
  placementRemoved: z.number().int().nonnegative(),
  placementChanged: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  rootFailures: z.number().int().nonnegative(),
  preservation: z.object({
    available: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    corrupt: z.number().int().nonnegative(),
  }),
  restoration: z.object({
    reference: z.number().int().nonnegative(),
    snapshot: z.number().int().nonnegative(),
  }),
});

const statusFields = {
  schemaVersion: z.literal(1),
  environment: z.string(),
  observedAt: timestampSchema,
  desiredCount: z.number().int().nonnegative(),
  skills: z.array(skillStatusSchema),
  untracked: z.array(untrackedSkillSchema),
  placementDrift: z.array(placementDriftSchema),
  invalidSkills: z.array(invalidDiscoveredSkillSchema),
  rootFailures: z.array(scannedRootSchema),
  stacks: z.array(environmentStackLayerSchema).optional(),
  summary: environmentStatusSummarySchema,
};

export const environmentStatusSchema = z.object(statusFields);
export const environmentDiffSchema = z.object({
  ...statusFields,
  entries: z.array(skillStatusSchema),
});

export type MachineIdentity = z.infer<typeof machineIdentitySchema>;
export type EnvironmentSkillEntry = z.infer<typeof environmentSkillEntrySchema>;
export type EnvironmentManifest = z.infer<typeof environmentManifestSchema>;
export type LockedSkill = z.infer<typeof lockedSkillSchema>;
export type EnvironmentLock = z.infer<typeof environmentLockSchema>;
export type BaselineLocation = z.infer<typeof baselineLocationSchema>;
export type MachineEnvironmentBaseline = z.infer<
  typeof machineEnvironmentBaselineSchema
>;
export type SkillStatus = z.infer<typeof skillStatusSchema>;
export type PlacementDrift = z.infer<typeof placementDriftSchema>;
export type EnvironmentStatus = z.infer<typeof environmentStatusSchema>;
export type EnvironmentDiff = z.infer<typeof environmentDiffSchema>;
