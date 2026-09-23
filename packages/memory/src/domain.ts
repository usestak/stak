import { z } from 'zod';

/**
 * Memory classifications. Each captured item is exactly one kind. These are the
 * only durable-context surfaces Stack Memory V0 preserves — see the allowlist in
 * `claude-adapter.ts`. Transcripts, history, caches, auth, and settings are NOT
 * memory and are never captured.
 */
export const memoryKindSchema = z.enum([
  'auto-memory', // Claude project auto-memory (projects/<key>/memory/**)
  'agent-memory', // persistent subagent memory (agent-memory/<agent>/**)
  'user-instructions', // personal global instructions (~/.claude/CLAUDE.md)
  'project-private-instructions', // project-local private instructions (CLAUDE.local.md)
]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const memoryScopeSchema = z.enum(['global', 'project']);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryProviderSchema = z.enum(['claude']);
export type MemoryProvider = z.infer<typeof memoryProviderSchema>;

/** A content hash of raw file bytes. */
export const memoryHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/**
 * Portable project identity. Prefer a canonical Git remote identity so the same
 * project is recognized across machines and moved directories. When no portable
 * Git identity exists, the identity is `local` and unresolved — restore must
 * rebind it to a real local project. Never contains credentials or absolute
 * machine paths (the vendor key is a Claude-specific, machine-local hint only).
 */
export const projectIdentitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('git'),
    canonical: z.string().min(1), // e.g. github.com/owner/repo
    host: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  z.object({
    kind: z.literal('local'),
    vendorKey: z.string().min(1).optional(),
  }),
]);
export type ProjectIdentity = z.infer<typeof projectIdentitySchema>;
export type GitProjectIdentity = Extract<ProjectIdentity, { kind: 'git' }>;

/**
 * Portable restore-target descriptor. Never an absolute path: it names a base
 * (resolved against the target machine's Claude home or a rebound project) and a
 * fenced relative path.
 */
export const restoreTargetSchema = z.discriminatedUnion('base', [
  // Resolved against the target machine's Claude home. (CLAUDE.md, agent-memory/**)
  z.object({ base: z.literal('claude-home'), relativePath: z.string().min(1) }),
  // Claude auto-memory: <claudeHome>/projects/<computed key>/memory/<rel>.
  z.object({
    base: z.literal('claude-project-memory'),
    relativePath: z.string().min(1),
  }),
  // Resolved against a rebound local project directory. (CLAUDE.local.md, .claude/agent-memory/**)
  z.object({ base: z.literal('project'), relativePath: z.string().min(1) }),
]);
export type RestoreTarget = z.infer<typeof restoreTargetSchema>;

/**
 * A discovered memory item, in memory. `source.path` is machine-local and is
 * NEVER written to the portable manifest.
 */
export type DiscoveredMemoryItem = {
  provider: MemoryProvider;
  kind: MemoryKind;
  scope: MemoryScope;
  logicalId: string;
  project?: ProjectIdentity;
  contentHash: string;
  restoreTarget: RestoreTarget;
  source: { path: string; vendorKey?: string };
  capturedAt: string;
  sensitivity: 'private';
};

/** Portable manifest item — no absolute paths, no credentials, no vendor keys. */
export const manifestItemSchema = z.object({
  provider: memoryProviderSchema,
  kind: memoryKindSchema,
  scope: memoryScopeSchema,
  logicalId: z.string().min(1),
  project: projectIdentitySchema.optional(),
  contentHash: memoryHashSchema,
  restoreTarget: restoreTargetSchema,
  capturedAt: z.iso.datetime({ offset: true }),
  sensitivity: z.literal('private'),
});
export type ManifestItem = z.infer<typeof manifestItemSchema>;

export const memoryManifestSchema = z.object({
  schemaVersion: z.literal(1),
  provider: memoryProviderSchema,
  createdAt: z.iso.datetime({ offset: true }),
  items: z.array(manifestItemSchema),
});
export type MemoryManifest = z.infer<typeof memoryManifestSchema>;

/** Strip machine-local fields, producing a portable manifest item. */
export const toManifestItem = (item: DiscoveredMemoryItem): ManifestItem =>
  manifestItemSchema.parse({
    provider: item.provider,
    kind: item.kind,
    scope: item.scope,
    logicalId: item.logicalId,
    ...(item.project ? { project: item.project } : {}),
    contentHash: item.contentHash,
    restoreTarget: item.restoreTarget,
    capturedAt: item.capturedAt,
    sensitivity: item.sensitivity,
  });
