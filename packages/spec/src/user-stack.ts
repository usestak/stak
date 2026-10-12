import { z } from 'zod';

import { portableRestorationStrategySchema } from './cloud.js';
import { entryIdSchema } from './environment.js';
import { publicSlugSchema } from './public.js';
import { skillMetadataSchema, skillSourceSchema } from './scanner.js';
import { contentHashSchema } from './storage.js';

/* -------------------------------------------------------------------------- */
/* Named Stack bundle (private, account-owned — P10B)                         */
/* -------------------------------------------------------------------------- */

// A Skill as carried inside a named Stack's own composition. Unlike a public-Stack
// requirement, `restoration` is the FULL union (reference or snapshot) — a private named
// Stack never leaves the account, so a Local/snapshot-backed Skill is perfectly includable;
// the reference-only restriction only applies at the moment a Stack is PUBLISHED (§15).
export const userStackSkillSchema = z.object({
  skillId: entryIdSchema,
  name: z.string().min(1),
  contentHash: contentHashSchema,
  metadata: skillMetadataSchema,
  restoration: portableRestorationStrategySchema,
  observedSources: z.array(skillSourceSchema),
  preferredSource: skillSourceSchema.optional(),
  // Desired state WITHIN this Stack's own composition — independent of whether the same
  // Skill is paused in `main` right now (spec §13: "pause/resume Skill in the Stack").
  paused: z.boolean().optional(),
});
export const userStackBundleSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  description: z.string(),
  skills: z.array(userStackSkillSchema),
});

/* -------------------------------------------------------------------------- */
/* Web/CLI DTOs                                                               */
/* -------------------------------------------------------------------------- */

export const userStackVersionSummarySchema = z.object({
  versionId: z.uuid(),
  versionNumber: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
});
export const userStackSummarySchema = z.object({
  stackId: z.uuid(),
  name: z.string().min(1),
  description: z.string(),
  skillCount: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
  versionNumber: z.number().int().nonnegative(),
});
export const listUserStacksResponseSchema = z.object({
  stacks: z.array(userStackSummarySchema),
});

export const userStackDetailSchema = z.object({
  stackId: z.uuid(),
  name: z.string().min(1),
  description: z.string(),
  skills: z.array(userStackSkillSchema),
  version: userStackVersionSummarySchema.nullable(),
});

export const createUserStackRequestSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(2000).optional(),
  skillIds: z.array(entryIdSchema).min(1),
});
export const createUserStackResponseSchema = z.object({
  stackId: z.uuid(),
  name: z.string().min(1),
  version: userStackVersionSummarySchema,
});

export const updateUserStackRequestSchema = z.object({
  stackId: z.uuid(),
  expectedLatestVersionId: z.uuid().nullable(),
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(2000).optional(),
  // Full desired composition when present (immutable new version); omitted = composition
  // unchanged, this call is a pure rename/description edit (no new version).
  skills: z
    .array(z.object({ skillId: entryIdSchema, paused: z.boolean().optional() }))
    .optional(),
});
export const updateUserStackResponseSchema = z.object({
  stackId: z.uuid(),
  name: z.string().min(1),
  version: userStackVersionSummarySchema.nullable(),
});

export const publishUserStackRequestSchema = z.object({
  stackId: z.uuid(),
  slug: publicSlugSchema,
  displayName: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
});

/* -------------------------------------------------------------------------- */
/* CLI: fetch an owned named Stack by name (`stak use <name>`, spec §14)      */
/* -------------------------------------------------------------------------- */

export const getUserStackResponseSchema = z.object({
  stackId: z.uuid(),
  name: z.string().min(1),
  bundle: userStackBundleSchema,
  version: userStackVersionSummarySchema,
});

export type UserStackSkill = z.infer<typeof userStackSkillSchema>;
export type UserStackBundle = z.infer<typeof userStackBundleSchema>;
export type UserStackVersionSummary = z.infer<
  typeof userStackVersionSummarySchema
>;
export type UserStackSummary = z.infer<typeof userStackSummarySchema>;
export type ListUserStacksResponse = z.infer<
  typeof listUserStacksResponseSchema
>;
export type UserStackDetail = z.infer<typeof userStackDetailSchema>;
export type CreateUserStackRequest = z.infer<
  typeof createUserStackRequestSchema
>;
export type CreateUserStackResponse = z.infer<
  typeof createUserStackResponseSchema
>;
export type UpdateUserStackRequest = z.infer<
  typeof updateUserStackRequestSchema
>;
export type UpdateUserStackResponse = z.infer<
  typeof updateUserStackResponseSchema
>;
export type PublishUserStackRequest = z.infer<
  typeof publishUserStackRequestSchema
>;
export type GetUserStackResponse = z.infer<typeof getUserStackResponseSchema>;
