import { z } from 'zod';

import { resolvedEnvironmentSchema } from './stack.js';
import { contentHashSchema } from './storage.js';

export const trySessionStatusSchema = z.enum([
  'preparing',
  'ready',
  'running',
  'exited',
  'failed',
  'cleaning',
  'cleanup-failed',
]);
export const tryCleanupComponentSchema = z.enum([
  'workspace',
  'home',
  'codex-home',
  'session-root',
  'unexpected-entry',
]);
// Safe, secret-free diagnostic recorded when a runtime component could not be
// removed. Contains only which component failed, a filesystem error code, and a
// timestamp — never file contents, config, or auth material.
export const tryCleanupDiagnosticSchema = z.object({
  component: tryCleanupComponentSchema,
  code: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  at: z.iso.datetime({ offset: true }),
});
export const trySessionSkillSchema = z.object({
  entryId: z.string().regex(/^skill_[A-Za-z0-9_-]{8,}$/),
  name: z.string().min(1),
  contentHash: contentHashSchema,
  targetPath: z.string().min(1),
});
export const trySessionSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().regex(/^try_[A-Za-z0-9_-]{8,}$/),
  agent: z.literal('codex'),
  createdAt: z.iso.datetime({ offset: true }),
  ownerPid: z.number().int().positive(),
  source: z.object({
    type: z.literal('local-stack'),
    displayName: z.string().min(1),
  }),
  runtimeRootPath: z.string().min(1),
  workspacePath: z.string().min(1),
  runtimeHomePath: z.string().min(1),
  runtimeCodexHomePath: z.string().min(1),
  resolvedSkills: z.array(trySessionSkillSchema),
  status: trySessionStatusSchema,
  cleanup: tryCleanupDiagnosticSchema.optional(),
});
export const tryIsolationPlanSchema = z.object({
  temporaryHome: z.literal(true),
  temporaryCodexHome: z.literal(true),
  scratchWorkspace: z.literal(true),
  normalBindingsUntouched: z.literal(true),
  mainUntouched: z.literal(true),
});
export const tryResolvedEnvironmentSchema = z.object({
  stackName: z.string().min(1),
  stackVersionHash: contentHashSchema,
  environment: resolvedEnvironmentSchema,
  skippedOptional: z.number().int().nonnegative(),
  required: z.number().int().nonnegative(),
  optionalIncluded: z.number().int().nonnegative(),
  isolation: tryIsolationPlanSchema,
});
export const tryPreparationResultSchema = z.object({
  session: trySessionSchema,
  bridgedFiles: z.array(z.string().min(1)),
});
export const tryExitResultSchema = z.object({
  sessionId: z.string().regex(/^try_[A-Za-z0-9_-]{8,}$/),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable().optional(),
  cleaned: z.boolean(),
  // Present only when cleaned === false: what was left behind and why, plus the
  // retained (Stack-owned, under STACK_HOME) runtime path for a safe later retry.
  cleanup: tryCleanupDiagnosticSchema.optional(),
  retainedRuntimePath: z.string().min(1).optional(),
});

export type TrySessionStatus = z.infer<typeof trySessionStatusSchema>;
export type TryCleanupComponent = z.infer<typeof tryCleanupComponentSchema>;
export type TryCleanupDiagnostic = z.infer<typeof tryCleanupDiagnosticSchema>;
export type TrySession = z.infer<typeof trySessionSchema>;
export type TryIsolationPlan = z.infer<typeof tryIsolationPlanSchema>;
export type TryResolvedEnvironment = z.infer<
  typeof tryResolvedEnvironmentSchema
>;
export type TryPreparationResult = z.infer<typeof tryPreparationResultSchema>;
export type TryExitResult = z.infer<typeof tryExitResultSchema>;
