import { createHash } from 'node:crypto';

import { z } from 'zod';

import { memoryHashSchema } from '../domain.js';
import { PROJECT_ID_PATTERN } from '../project/project-id.js';

export const CANONICAL_MAIN_SCHEMA_VERSION = 2 as const;

export const canonicalImportedFromSchema = z.literal('claude');

export const canonicalDocPresentSchema = z.object({
  path: z.string().min(1),
  state: z.literal('present'),
  contentHash: memoryHashSchema,
  importedFrom: canonicalImportedFromSchema,
  importedAt: z.iso.datetime({ offset: true }),
});
export type CanonicalDocPresent = z.infer<typeof canonicalDocPresentSchema>;

export const canonicalDocDeletedSchema = z.object({
  path: z.string().min(1),
  state: z.literal('deleted'),
  lastContentHash: memoryHashSchema,
  deletedAt: z.iso.datetime({ offset: true }),
});
export type CanonicalDocDeleted = z.infer<typeof canonicalDocDeletedSchema>;

export const canonicalDocSchema = z.discriminatedUnion('state', [
  canonicalDocPresentSchema,
  canonicalDocDeletedSchema,
]);
export type CanonicalDoc = z.infer<typeof canonicalDocSchema>;

export const canonicalProjectMemorySchema = z.object({
  projectId: z.string().regex(PROJECT_ID_PATTERN),
  documents: z.array(canonicalDocSchema),
});
export type CanonicalProjectMemory = z.infer<
  typeof canonicalProjectMemorySchema
>;

export const canonicalMainManifestSchema = z.object({
  schemaVersion: z.literal(CANONICAL_MAIN_SCHEMA_VERSION),
  projects: z.array(canonicalProjectMemorySchema),
});
export type CanonicalMainManifest = z.infer<typeof canonicalMainManifestSchema>;

export const emptyCanonicalMain = (): CanonicalMainManifest => ({
  schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
  projects: [],
});

export const canonicalDigestInput = (main: CanonicalMainManifest): string =>
  JSON.stringify({
    schemaVersion: main.schemaVersion,
    projects: [...main.projects]
      .map((project) => ({
        projectId: project.projectId,
        documents: [...project.documents].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        ),
      }))
      .sort((a, b) =>
        a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0,
      ),
  });

export const canonicalDigest = (main: CanonicalMainManifest): string =>
  `sha256:${createHash('sha256')
    .update(canonicalDigestInput(main))
    .digest('hex')}`;

export const projectMemoryOf = (
  main: CanonicalMainManifest,
  projectId: string,
): CanonicalProjectMemory | undefined =>
  main.projects.find((project) => project.projectId === projectId);

export const documentOf = (
  main: CanonicalMainManifest,
  projectId: string,
  path: string,
): CanonicalDoc | undefined =>
  projectMemoryOf(main, projectId)?.documents.find((doc) => doc.path === path);
