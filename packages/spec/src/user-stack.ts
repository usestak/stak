import { z } from 'zod';

import { portableRestorationStrategySchema } from './cloud.js';
import { entryIdSchema } from './environment.js';
import { publicHandleSchema, publicSlugSchema } from './public.js';
import { skillMetadataSchema, skillSourceSchema } from './scanner.js';
import { contentHashSchema } from './storage.js';

/* -------------------------------------------------------------------------- */
/* Named Stack name — one canonical identifier (spec P10 correction §1/§5)    */
/* -------------------------------------------------------------------------- */

/** `main` is the special active desired environment — never usable as a saved Stack name,
 *  in any case variant, so `stak use main` can never be ambiguous between the two. */
const RESERVED_USER_STACK_NAMES = new Set(['main']);

/** Trim + lowercase — the ONE normalization step every caller (web/CLI/server) must apply
 *  before a name reaches validation or storage, so `Frontend`/`frontend`/` frontend ` are
 *  provably the same identity rather than three independently-creatable rows. */
export const canonicalizeUserStackName = (raw: string): string =>
  raw.trim().toLowerCase();

/**
 * Canonical named-Stack name: reuses the existing public Stack/Skill slug convention
 * (`publicSlugSchema`'s character class) rather than inventing a second syntax, plus the
 * two product-frozen rejections: `main` (reserved, see above) and a leading `@` (which
 * `stak use` always treats as a public `@owner/slug` reference — see spec P10 §9 — so a
 * Stack named that way would be permanently unreachable by name).
 */
export const userStackNameSchema = z
  .string()
  .transform(canonicalizeUserStackName)
  .pipe(
    publicSlugSchema.refine((name) => !RESERVED_USER_STACK_NAMES.has(name), {
      message: '"main" is reserved and cannot be used as a saved Stack name.',
    }),
  );

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
  name: userStackNameSchema,
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
  name: userStackNameSchema.optional(),
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

/** Truthful publication lifecycle for a named Stack (spec P10 correction §13) — a server-
 *  resolved status, not ephemeral UI state, so a page reload shows the real current state
 *  instead of silently reverting to "private". No `unpublished`/tombstone state yet: §4 of
 *  the correction pass found that genuinely needs new schema and stopped short of adding it
 *  (see migration audit report) — only create/update/no-op-republish are supported today. */
export const userStackPublicationStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('private') }),
  // Eligible by shape, but at least one Skill's content isn't yet in STAK Cloud — publishing
  // now is guaranteed to fail. Mirrors the single-Skill share status of the same name.
  z.object({ status: z.literal('upload-required') }),
  z.object({
    status: z.literal('published'),
    owner: publicHandleSchema,
    slug: publicSlugSchema,
    url: z.string().min(1),
    versionNumber: z.number().int().positive(),
  }),
  z.object({
    status: z.literal('changed-since-published'),
    owner: publicHandleSchema,
    slug: publicSlugSchema,
    url: z.string().min(1),
    versionNumber: z.number().int().positive(),
  }),
  // The currently-published version exists but was published before snapshot-first
  // publication (its requirements are Git-reference-restored, not immutable content
  // snapshots) — still readable for backward compatibility (never deleted/rewritten), but
  // not equivalent to a current portable publication. Republishing produces a fresh
  // snapshot-backed version at the next version number.
  z.object({
    status: z.literal('portable-republish-needed'),
    owner: publicHandleSchema,
    slug: publicSlugSchema,
    url: z.string().min(1),
    versionNumber: z.number().int().positive(),
  }),
]);
export type UserStackPublicationStatus = z.infer<
  typeof userStackPublicationStatusSchema
>;
export const getUserStackPublicationStatusResponseSchema = z.object({
  stackId: z.uuid(),
  publication: userStackPublicationStatusSchema,
});
export type GetUserStackPublicationStatusResponse = z.infer<
  typeof getUserStackPublicationStatusResponseSchema
>;

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
