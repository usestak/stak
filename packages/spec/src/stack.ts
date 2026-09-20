import { z } from 'zod';

import { skillMetadataSchema, skillSourceSchema } from './scanner.js';
import { contentHashSchema, restorationStrategySchema } from './storage.js';

export const requirementKindSchema = z.enum(['required', 'optional']);
export const stackManifestSkillSchema = z.object({
  path: z.string().min(1),
  requirement: requirementKindSchema.default('required'),
});
export const stackManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  description: z.string().min(1),
  extends: z.array(z.string().min(1)).default([]),
  skills: z.array(stackManifestSkillSchema).default([]),
});

export const stackSkillRequirementSchema = z.object({
  id: z.string().regex(/^req_[A-Za-z0-9_-]{8,}$/),
  name: z.string().min(1),
  requirement: requirementKindSchema,
  contentHash: contentHashSchema,
  metadata: skillMetadataSchema,
  restoration: restorationStrategySchema,
  observedSources: z.array(skillSourceSchema),
  preferredSource: skillSourceSchema.optional(),
  originStackName: z.string().min(1),
});
export const skippedStackRequirementSchema = z.object({
  stackName: z.string().min(1),
  path: z.string().min(1),
  reason: z.string().min(1),
});
export const importedStackVersionSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  description: z.string().min(1),
  versionHash: contentHashSchema,
  requirements: z.array(stackSkillRequirementSchema),
  inheritedStacks: z.array(
    z.object({ name: z.string(), versionHash: contentHashSchema }),
  ),
  skippedOptional: z.array(skippedStackRequirementSchema),
});
export const importedStackSchema = z.object({
  schemaVersion: z.literal(1),
  stackId: z.string().regex(/^stack_[A-Za-z0-9_-]{8,}$/),
  version: importedStackVersionSchema,
});

export const environmentStackLayerSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }),
  z.object({
    kind: z.literal('public'),
    ref: z.string().min(1),
    owner: z.string().min(1),
    slug: z.string().min(1),
    publicStackId: z.uuid(),
    publicVersionId: z.uuid(),
    versionHash: contentHashSchema,
  }),
]);
export const environmentStackLayerSchema = z.object({
  id: z.string().regex(/^layer_[A-Za-z0-9_-]{8,}$/),
  stackId: z.string().regex(/^stack_[A-Za-z0-9_-]{8,}$/),
  name: z.string().min(1),
  versionHash: contentHashSchema,
  source: environmentStackLayerSourceSchema.optional(),
});
export const requirementOriginSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('direct'),
    entryId: z.string().regex(/^skill_[A-Za-z0-9_-]{8,}$/),
  }),
  z.object({
    type: z.literal('stack'),
    layerId: z.string().regex(/^layer_[A-Za-z0-9_-]{8,}$/),
    stackId: z.string().regex(/^stack_[A-Za-z0-9_-]{8,}$/),
    stackName: z.string().min(1),
    requirementId: z.string().regex(/^req_[A-Za-z0-9_-]{8,}$/),
    requirement: requirementKindSchema,
  }),
]);
export const resolvedEnvironmentSkillSchema = z.object({
  entryId: z.string().regex(/^skill_[A-Za-z0-9_-]{8,}$/),
  name: z.string().min(1),
  contentHash: contentHashSchema,
  metadata: skillMetadataSchema,
  restoration: restorationStrategySchema,
  observedSources: z.array(skillSourceSchema),
  preferredSource: skillSourceSchema.optional(),
  origins: z.array(requirementOriginSchema).min(1),
});
export const skippedRequirementSchema = z.object({
  name: z.string(),
  contentHash: contentHashSchema.optional(),
  origin: requirementOriginSchema.optional(),
  reason: z.enum(['optional-invalid', 'required-wins', 'optional-conflict']),
});
export const resolutionConflictSchema = z.object({
  name: z.string(),
  candidates: z
    .array(
      z.object({
        contentHash: contentHashSchema,
        origins: z.array(requirementOriginSchema),
      }),
    )
    .min(2),
});
export const resolvedEnvironmentSchema = z.object({
  name: z.string(),
  skills: z.array(resolvedEnvironmentSkillSchema),
  skipped: z.array(skippedRequirementSchema),
  conflicts: z.array(resolutionConflictSchema),
});

export type StackManifest = z.infer<typeof stackManifestSchema>;
export type StackSkillRequirement = z.infer<typeof stackSkillRequirementSchema>;
export type ImportedStackVersion = z.infer<typeof importedStackVersionSchema>;
export type ImportedStack = z.infer<typeof importedStackSchema>;
export type EnvironmentStackLayer = z.infer<typeof environmentStackLayerSchema>;
export type EnvironmentStackLayerSource = z.infer<
  typeof environmentStackLayerSourceSchema
>;
export type RequirementOrigin = z.infer<typeof requirementOriginSchema>;
export type ResolvedEnvironmentSkill = z.infer<
  typeof resolvedEnvironmentSkillSchema
>;
export type ResolvedEnvironment = z.infer<typeof resolvedEnvironmentSchema>;
export type ResolutionConflict = z.infer<typeof resolutionConflictSchema>;
export type SkippedRequirement = z.infer<typeof skippedRequirementSchema>;
