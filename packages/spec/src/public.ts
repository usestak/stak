import { z } from 'zod';

import { skillMetadataSchema, skillSourceSchema } from './scanner.js';
import { contentHashSchema, referenceRestorationSchema } from './storage.js';

/* -------------------------------------------------------------------------- */
/* Handles, slugs, and @owner/name parsing                                    */
/* -------------------------------------------------------------------------- */

// Lowercase; starts alphanumeric; hyphens allowed; <= 39 chars (GitHub-like).
export const publicHandleSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/);
// Conservative Stack slug: lowercase start, then [a-z0-9-_], <= 63 chars.
export const publicSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-_]{0,62}$/);

export type PublicStackRef = { owner: string; slug: string };

export class PublicStackRefError extends Error {
  readonly code = 'invalid-public-stack-ref';
  constructor(message: string) {
    super(message);
    this.name = 'PublicStackRefError';
  }
}

/**
 * Canonical parser for `@owner/name`. Exactly one leading `@`, exactly one
 * owner and one slug, no path traversal or extra segments. Case is preserved as
 * given and validated against the lowercase handle/slug rules (no silent
 * transformation).
 */
export const parsePublicStackRef = (input: string): PublicStackRef => {
  if (typeof input !== 'string' || !input.startsWith('@'))
    throw new PublicStackRefError(
      `Public Stack references must look like @owner/name: ${input}`,
    );
  const body = input.slice(1);
  const parts = body.split('/');
  if (parts.length !== 2)
    throw new PublicStackRefError(
      `Public Stack references must contain exactly one owner and one name: ${input}`,
    );
  const [owner, slug] = parts;
  if (!owner || !slug)
    throw new PublicStackRefError(`Malformed public Stack reference: ${input}`);
  if (!publicHandleSchema.safeParse(owner).success)
    throw new PublicStackRefError(`Invalid owner handle: @${owner}`);
  if (!publicSlugSchema.safeParse(slug).success)
    throw new PublicStackRefError(`Invalid Stack slug: ${slug}`);
  return { owner, slug };
};

export const formatPublicStackRef = (ref: PublicStackRef): string =>
  `@${ref.owner}/${ref.slug}`;

export const isPublicStackRef = (input: string): boolean =>
  input.startsWith('@');

/* -------------------------------------------------------------------------- */
/* Public source-remote safety                                                */
/* -------------------------------------------------------------------------- */

export type PublicSourceVerdict =
  | { safe: true; scheme: 'https' | 'ssh' | 'git' | 'scp' }
  | { safe: false; reason: string };

/**
 * Validate that a Git remote is safe to expose publicly: no embedded
 * credentials, no local/file/loopback remotes, only distributable schemes. SSH
 * and SCP-style references are allowed (displayed as text). Never echoes the
 * remote back in the reason to avoid leaking embedded credential material.
 */
export const inspectPublicSourceRemote = (
  remote: string,
): PublicSourceVerdict => {
  const value = remote.trim();
  if (!value) return { safe: false, reason: 'Empty source remote.' };
  if (
    /^file:/i.test(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('/')
  )
    return {
      safe: false,
      reason: 'Local filesystem remotes cannot be published.',
    };

  if (/^https:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { safe: false, reason: 'Malformed HTTPS remote.' };
    }
    if (url.username || url.password)
      return {
        safe: false,
        reason: 'Source remote contains embedded credentials.',
      };
    if (isLoopbackHost(url.hostname))
      return { safe: false, reason: 'Loopback remotes cannot be published.' };
    return { safe: true, scheme: 'https' };
  }
  if (/^ssh:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { safe: false, reason: 'Malformed SSH remote.' };
    }
    if (url.password)
      return {
        safe: false,
        reason: 'Source remote contains embedded credentials.',
      };
    if (isLoopbackHost(url.hostname))
      return { safe: false, reason: 'Loopback remotes cannot be published.' };
    return { safe: true, scheme: 'ssh' };
  }
  if (/^git:\/\//i.test(value)) return { safe: true, scheme: 'git' };
  // scp-style: user@host:path (no scheme). Reject ones with a password-like ':'.
  const scp = /^([^@/\\\s:]+)@([^/\\\s:]+):(.+)$/.exec(value);
  if (scp) {
    const host = scp[2] ?? '';
    if (isLoopbackHost(host))
      return { safe: false, reason: 'Loopback remotes cannot be published.' };
    return { safe: true, scheme: 'scp' };
  }
  return { safe: false, reason: 'Unsupported or unsafe source remote scheme.' };
};

const isLoopbackHost = (host: string): boolean =>
  host === 'localhost' ||
  host === '127.0.0.1' ||
  host === '::1' ||
  host.endsWith('.localhost');

/** Only http(s) links may be rendered as anchors on public pages. */
export const isSafeDisplayUrl = (value: string): boolean =>
  /^https?:\/\//i.test(value.trim()) &&
  !/\s/.test(value.trim()) &&
  (() => {
    try {
      const url = new URL(value.trim());
      return !url.username && !url.password;
    } catch {
      return false;
    }
  })();

/* -------------------------------------------------------------------------- */
/* Public Stack bundle (reference-only)                                       */
/* -------------------------------------------------------------------------- */

export const publicStackRequirementSchema = z.object({
  id: z.string().regex(/^req_[A-Za-z0-9_-]{8,}$/),
  name: z.string().min(1),
  requirement: z.enum(['required', 'optional']),
  contentHash: contentHashSchema,
  metadata: skillMetadataSchema,
  restoration: referenceRestorationSchema,
  observedSources: z.array(skillSourceSchema),
  preferredSource: skillSourceSchema.optional(),
  originStackName: z.string().min(1),
});
export const publicStackBundleSchema = z.object({
  schemaVersion: z.literal(1),
  stack: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    versionHash: contentHashSchema,
  }),
  requirements: z.array(publicStackRequirementSchema),
  inheritedStackMetadata: z.array(
    z.object({ name: z.string().min(1), versionHash: contentHashSchema }),
  ),
  digest: contentHashSchema,
});

/* -------------------------------------------------------------------------- */
/* Public API DTOs                                                            */
/* -------------------------------------------------------------------------- */

export const publicStackVersionSummarySchema = z.object({
  versionId: z.uuid(),
  versionNumber: z.number().int().positive(),
  versionHash: contentHashSchema,
  digest: contentHashSchema,
  createdAt: z.iso.datetime({ offset: true }),
});
export const getPublicStackResponseSchema = z.object({
  stackId: z.uuid(),
  owner: publicHandleSchema,
  slug: publicSlugSchema,
  displayName: z.string().min(1),
  description: z.string(),
  updatedAt: z.iso.datetime({ offset: true }),
  latest: z
    .object({
      version: publicStackVersionSummarySchema,
      bundle: publicStackBundleSchema,
    })
    .nullable(),
});
export const getPublicStackVersionResponseSchema = z.object({
  owner: publicHandleSchema,
  slug: publicSlugSchema,
  version: publicStackVersionSummarySchema,
  bundle: publicStackBundleSchema,
});
export const publicProfileResponseSchema = z.object({
  owner: publicHandleSchema,
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
  stacks: z.array(
    z.object({
      slug: publicSlugSchema,
      displayName: z.string().min(1),
      description: z.string(),
      latestVersionNumber: z.number().int().positive().nullable(),
      updatedAt: z.iso.datetime({ offset: true }),
    }),
  ),
});

export const publishPublicStackVersionRequestSchema = z.object({
  slug: publicSlugSchema,
  displayName: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  bundle: publicStackBundleSchema,
  expectedLatestVersionId: z.uuid().nullable(),
  idempotencyKey: z.uuid().optional(),
  machineId: z.uuid().optional(),
});
export const publishPublicStackVersionResponseSchema = z.object({
  owner: publicHandleSchema,
  slug: publicSlugSchema,
  stackId: z.uuid(),
  version: publicStackVersionSummarySchema,
  url: z.string().min(1),
  createdNew: z.boolean(),
});

export type PublicStackRequirement = z.infer<
  typeof publicStackRequirementSchema
>;
export type PublicStackBundle = z.infer<typeof publicStackBundleSchema>;
export type PublicStackVersionSummary = z.infer<
  typeof publicStackVersionSummarySchema
>;
export type GetPublicStackResponse = z.infer<
  typeof getPublicStackResponseSchema
>;
export type GetPublicStackVersionResponse = z.infer<
  typeof getPublicStackVersionResponseSchema
>;
export type PublicProfileResponse = z.infer<typeof publicProfileResponseSchema>;
export type PublishPublicStackVersionRequest = z.infer<
  typeof publishPublicStackVersionRequestSchema
>;
export type PublishPublicStackVersionResponse = z.infer<
  typeof publishPublicStackVersionResponseSchema
>;
