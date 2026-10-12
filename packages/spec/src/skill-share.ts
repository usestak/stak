import { z } from 'zod';

import type { PortableRestorationStrategy } from './cloud.js';
import { entryIdSchema } from './environment.js';
import {
  inspectPublicSourceRemote,
  publicHandleSchema,
  publicSlugSchema,
  publishPublicStackVersionResponseSchema,
} from './public.js';
import type { SnapshotReason } from './storage.js';

/* -------------------------------------------------------------------------- */
/* Eligibility (pure, no I/O — safe to call from CLI, Cloud, or web)          */
/* -------------------------------------------------------------------------- */

export const skillShareEligibilitySchema = z.discriminatedUnion('eligible', [
  z.object({ eligible: z.literal(true) }),
  z.object({ eligible: z.literal(false), reason: z.string().min(1) }),
]);
export type SkillShareEligibility = z.infer<typeof skillShareEligibilitySchema>;

/**
 * Plain-language, non-technical explanations for each structural reason a Skill cannot be
 * published as a safe public reference. Mirrors `snapshotReasonSchema` 1:1. Never surfaces a
 * raw hash, path, or remote — only the Skill's name is ever interpolated by the caller.
 */
const SNAPSHOT_REASON_COPY: Record<SnapshotReason, string> = {
  local:
    "This Skill comes from a local source, so STAK can't publish a safe public reference for it.",
  'unknown-source':
    "STAK couldn't determine a safe, public source for this Skill, so it can't be shared.",
  'ambiguous-source':
    "This Skill's source is ambiguous, so STAK can't publish a safe public reference for it.",
  'modified-source':
    "This Skill's local copy has changed from its source, so STAK can't publish a safe public reference for it.",
  'non-portable-source':
    "This Skill's source isn't portable enough for STAK to publish safely.",
};

/**
 * Decide whether a Skill's CURRENT APPROVED restoration can become a public reference.
 * Reuses the exact same structural guarantee the public-Stack pipeline already enforces
 * (snapshot-strategy Skills cannot be type-constructed into a public bundle) plus the same
 * source-remote safety check (`inspectPublicSourceRemote`) run at Stack-publish time — so a
 * Skill that is eligible here is, by construction, eligible for the underlying one-item
 * public Stack bundle it will become. Fails closed: any restoration shape this function does
 * not recognize as safe is not-eligible, never defaulted to eligible.
 */
export const assessSkillShareEligibility = (
  restoration: PortableRestorationStrategy,
): SkillShareEligibility => {
  if (restoration.strategy === 'snapshot')
    return {
      eligible: false,
      reason:
        SNAPSHOT_REASON_COPY[restoration.reason] ?? SNAPSHOT_REASON_COPY.local,
    };
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
