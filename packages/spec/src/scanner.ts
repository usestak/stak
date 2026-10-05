import { z } from 'zod';

export const skillRootKindSchema = z.enum([
  'agents',
  'cursor',
  'codex',
  'claude',
]);
export const skillScopeSchema = z.enum(['global', 'project']);
export const skillRootSchema = z.object({
  path: z.string(),
  rootKind: skillRootKindSchema,
  scope: skillScopeSchema,
});
export const skillSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('git'),
    remote: z.string().optional(),
    revision: z.string(),
    path: z.string(),
    clean: z.boolean().optional(),
    // The SOURCE LOCATOR: the mutable Git ref this checkout was tracking (e.g.
    // `refs/heads/release`, `refs/tags/v1`), distinct from `revision` (the exact approved
    // commit it resolved to). Optional/back-compat: absent = detached/exact-commit checkout,
    // which is intentionally not update-trackable. Source-latest re-resolves THIS ref, never
    // the repository default branch as a global fallback.
    ref: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('local') }),
  z.object({ type: z.literal('unknown'), reason: z.string().optional() }),
]);
export const skillLocationSchema = skillRootSchema.extend({
  rootPath: z.string(),
  isSymlink: z.boolean(),
  realPath: z.string().optional(),
  source: skillSourceSchema,
});
/**
 * Declared capabilities (P2, 0.1.0 contract §7). An OPTIONAL, structured block in SKILL.md
 * frontmatter. Each flag is TRI-STATE: present+true, present+false, or ABSENT (not declared).
 * Absence of a flag — or of the whole block — means "not declared", never `false`: capability
 * truth is declared only, never inferred from prose or skill bodies. The object is loose so
 * future declared keys round-trip; the four flags below are the recognized 0.1.0 surface.
 */
export const declaredCapabilitiesSchema = z
  .object({
    readFiles: z.boolean().optional(),
    writeFiles: z.boolean().optional(),
    runCommands: z.boolean().optional(),
    network: z.boolean().optional(),
  })
  .loose();
export const skillMetadataSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    capabilities: declaredCapabilitiesSchema.optional(),
  })
  .loose();
export const scanDiagnosticSchema = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
});
export const scannedRootSchema = skillRootSchema.extend({
  status: z.enum(['missing', 'scanned', 'failed']),
  skillLocations: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export const discoveredSkillSchema = z.object({
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  metadata: skillMetadataSchema.optional(),
  valid: z.boolean(),
  source: skillSourceSchema,
  locations: z.array(skillLocationSchema).min(1),
});
export const nameCollisionSchema = z.object({
  name: z.string(),
  contentHashes: z.array(z.string()).min(2),
});
export const scanSummarySchema = z.object({
  roots: z.object({
    scanned: z.number(),
    missing: z.number(),
    failed: z.number(),
  }),
  uniqueSkillContents: z.number().int().nonnegative(),
  locations: z.number().int().nonnegative(),
  validSkills: z.number().int().nonnegative(),
  invalidSkills: z.number().int().nonnegative(),
  exactDuplicateContents: z.number().int().nonnegative(),
  nameCollisions: z.number().int().nonnegative(),
  diagnostics: z.object({
    errors: z.number(),
    warnings: z.number(),
    info: z.number(),
  }),
  provenance: z.object({
    git: z.number(),
    local: z.number(),
    unknown: z.number(),
  }),
});
export const scanResultSchema = z.object({
  roots: z.array(scannedRootSchema),
  skills: z.array(discoveredSkillSchema),
  nameCollisions: z.array(nameCollisionSchema),
  diagnostics: z.array(scanDiagnosticSchema),
  summary: scanSummarySchema,
});

export type SkillRootKind = z.infer<typeof skillRootKindSchema>;
export type SkillScope = z.infer<typeof skillScopeSchema>;
export type SkillRoot = z.infer<typeof skillRootSchema>;
export type SkillSource = z.infer<typeof skillSourceSchema>;
export type SkillLocation = z.infer<typeof skillLocationSchema>;
export type DeclaredCapabilities = z.infer<typeof declaredCapabilitiesSchema>;
export type SkillMetadata = z.infer<typeof skillMetadataSchema>;
export type ScanDiagnostic = z.infer<typeof scanDiagnosticSchema>;
export type ScannedRoot = z.infer<typeof scannedRootSchema>;
export type DiscoveredSkill = z.infer<typeof discoveredSkillSchema>;
export type NameCollision = z.infer<typeof nameCollisionSchema>;
export type ScanSummary = z.infer<typeof scanSummarySchema>;
export type ScanResult = z.infer<typeof scanResultSchema>;
