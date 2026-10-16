import { z } from 'zod';

import type { PortableRestorationStrategy } from './cloud.js';
import { entryIdSchema } from './environment.js';
import {
  inspectPublicSourceRemote,
  publicHandleSchema,
  publicSlugSchema,
  publishPublicStackVersionResponseSchema,
} from './public.js';
/* -------------------------------------------------------------------------- */
/* Eligibility (pure, no I/O — safe to call from CLI, Cloud, or web)          */
/* -------------------------------------------------------------------------- */

export const skillShareEligibilitySchema = z.discriminatedUnion('eligible', [
  z.object({ eligible: z.literal(true) }),
  z.object({ eligible: z.literal(false), reason: z.string().min(1) }),
]);
export type SkillShareEligibility = z.infer<typeof skillShareEligibilitySchema>;

/**
 * Decide whether a Skill's CURRENT APPROVED restoration can become publicly shareable.
 *
 * Hybrid Public Skill Portability: every snapshot `reason` (local, unknown-source,
 * ambiguous-source, modified-source, non-portable-source) describes why STAK can't build a
 * safe public GIT REFERENCE for this Skill — none of them describe the Skill's content as
 * unreadable or unsafe to snapshot. The content itself was already hashed/fenced to its own
 * directory tree by the same primitive a reference-strategy Skill's content is (P5/P10
 * hashing), so a snapshot-strategy Skill is unconditionally eligible here: the Skill becomes
 * portable through an immutable content snapshot instead of a reference. This function stays
 * pure/no-I/O — whether the owner's Cloud-side bytes for that snapshot actually exist yet
 * (i.e. whether they've run `stak push`) is a publish-time I/O concern, checked separately by
 * the caller before the snapshot is actually copied into public storage.
 *
 * For reference-strategy Skills, the same source-remote safety check
 * (`inspectPublicSourceRemote`) run at Stack-publish time still applies — Git provenance
 * remains useful display/update-check metadata, never a hard runtime requirement either way.
 */
export const assessSkillShareEligibility = (
  restoration: PortableRestorationStrategy,
): SkillShareEligibility => {
  if (restoration.strategy === 'snapshot') return { eligible: true };
  const verdict = inspectPublicSourceRemote(restoration.reference.remote);
  if (!verdict.safe) return { eligible: false, reason: verdict.reason };
  return { eligible: true };
};

/* -------------------------------------------------------------------------- */
/* Web-facing share status + request/response DTOs                            */
/* -------------------------------------------------------------------------- */

export const skillShareStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('shareable'), suggestedSlug: publicSlugSchema }),
  z.object({
    status: z.literal('already-shared'),
    owner: publicHandleSchema,
    slug: publicSlugSchema,
    url: z.string().min(1),
    versionNumber: z.number().int().positive(),
  }),
  // The approved Skill's current revision differs from what's published — a truthful
  // lifecycle state (spec P10 correction §3), not a terminal one: calling shareSkill again
  // commits the newly-approved revision as the next immutable public version.
  z.object({
    status: z.literal('update-available'),
    owner: publicHandleSchema,
    slug: publicSlugSchema,
    url: z.string().min(1),
    versionNumber: z.number().int().positive(),
  }),
  z.object({ status: z.literal('not-shareable'), reason: z.string().min(1) }),
]);
export type SkillShareStatus = z.infer<typeof skillShareStatusSchema>;

export const getSkillShareStatusResponseSchema = z.object({
  skillId: entryIdSchema,
  share: skillShareStatusSchema,
});
export type GetSkillShareStatusResponse = z.infer<
  typeof getSkillShareStatusResponseSchema
>;

export const shareSkillRequestSchema = z.object({
  skillId: entryIdSchema,
  slug: publicSlugSchema,
  displayName: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
});
export type ShareSkillRequest = z.infer<typeof shareSkillRequestSchema>;

// Identical shape to publishing a Stack version — a Skill share IS one, by design (§3). Kept
// as its own exported symbol so callers never need to import or mention "Stack" to consume it.
export const shareSkillResponseSchema = publishPublicStackVersionResponseSchema;
export type ShareSkillResponse = z.infer<typeof shareSkillResponseSchema>;
