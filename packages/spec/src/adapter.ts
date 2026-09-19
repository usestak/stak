import { z } from 'zod';

import { contentHashSchema, storeVerificationSchema } from './storage.js';

const timestampSchema = z.iso.datetime({ offset: true });
const entryIdSchema = z.string().regex(/^skill_[A-Za-z0-9_-]{8,}$/);

export const agentIdSchema = z.enum(['codex', 'cursor', 'claude']);
export const agentDetectionSchema = z.object({
  agent: agentIdSchema,
  installed: z.boolean(),
  executablePath: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
});

export const resolvedBindingSkillSchema = z.object({
  entryId: entryIdSchema,
  name: z.string().min(1),
  contentHash: contentHashSchema,
});
export const resolvedLocalEnvironmentSchema = z.object({
  name: z.string().min(1),
  machineId: z.uuid(),
  skills: z.array(resolvedBindingSkillSchema),
});

export const bindingRecordSchema = z.object({
  environment: z.string().min(1),
  environmentEntryId: entryIdSchema,
  skillName: z.string().min(1),
  contentHash: contentHashSchema,
  targetPath: z.string().min(1),
  targetRoot: z.enum(['agents', 'claude']),
  createdAt: timestampSchema,
});
export const bindingRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  machineId: z.uuid(),
  bindings: z.array(bindingRecordSchema),
});

export const bindingStateSchema = z.enum([
  'already-managed',
  'externally-satisfied',
  'add',
  'update-managed',
  'managed-drift',
  'remove-managed',
  'conflict-unmanaged',
  'conflict-name',
  'invalid-target-name',
  'store-unavailable',
  'store-corrupt',
  'visibility-conflict',
]);
export const bindingOperationSchema = z.object({
  state: bindingStateSchema,
  entryId: entryIdSchema,
  skillName: z.string().min(1),
  contentHash: contentHashSchema,
  targetPath: z.string().min(1),
  currentHash: contentHashSchema.optional(),
  installedHash: contentHashSchema.optional(),
  preservation: storeVerificationSchema.optional(),
  message: z.string().optional(),
  stale: z.boolean().optional(),
});
export const bindingPlanSchema = z.object({
  schemaVersion: z.literal(1),
  agent: agentIdSchema,
  environment: z.string().min(1),
  targetRoot: z.string().min(1),
  operations: z.array(bindingOperationSchema),
  blocking: z.boolean(),
});

export const bindingApplyResultSchema = z.object({
  agent: agentIdSchema,
  applied: z.array(bindingRecordSchema),
  removed: z.array(bindingRecordSchema),
  unchanged: z.number().int().nonnegative(),
  rolledBack: z.boolean(),
});
export const bindingVerificationItemSchema = z.object({
  record: bindingRecordSchema,
  state: z.enum(['healthy', 'missing', 'changed']),
  currentHash: contentHashSchema.optional(),
});
export const bindingVerificationSchema = z.object({
  agent: agentIdSchema,
  healthy: z.boolean(),
  bindings: z.array(bindingVerificationItemSchema),
});
export const launchResultSchema = z.object({
  agent: agentIdSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable().optional(),
});

export type AgentId = z.infer<typeof agentIdSchema>;
export type AgentDetection = z.infer<typeof agentDetectionSchema>;
export type ResolvedBindingSkill = z.infer<typeof resolvedBindingSkillSchema>;
export type ResolvedLocalEnvironment = z.infer<
  typeof resolvedLocalEnvironmentSchema
>;
export type BindingRecord = z.infer<typeof bindingRecordSchema>;
export type BindingRegistry = z.infer<typeof bindingRegistrySchema>;
export type BindingState = z.infer<typeof bindingStateSchema>;
export type BindingOperation = z.infer<typeof bindingOperationSchema>;
export type BindingPlan = z.infer<typeof bindingPlanSchema>;
export type BindingApplyResult = z.infer<typeof bindingApplyResultSchema>;
export type BindingVerification = z.infer<typeof bindingVerificationSchema>;
export type LaunchResult = z.infer<typeof launchResultSchema>;
