import { z } from 'zod';

export const contentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const snapshotIdSchema = z.string().regex(/^snap_[A-Za-z0-9_-]{8,}$/);
export const snapshotReasonSchema = z.enum([
  'local',
  'unknown-source',
  'ambiguous-source',
  'modified-source',
  'non-portable-source',
]);

export const contentStoreMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  algorithm: z.literal('sha256'),
  contentHash: contentHashSchema,
  createdAt: z.iso.datetime({ offset: true }),
  kind: z.literal('skill'),
});

const portableRemoteSchema = z
  .string()
  .refine(
    (remote) =>
      /^(?:https:\/\/|ssh:\/\/|git:\/\/)/i.test(remote) ||
      /^[^/\\:@\s]+@[^/\\:\s]+:.+/.test(remote),
    'Git remote must be a portable HTTPS, SSH, Git, or SCP-style remote',
  );

export const referenceRecordSchema = z.object({
  remote: portableRemoteSchema,
  revision: z.string().min(1),
  path: z
    .string()
    .min(1)
    .refine(
      (value) =>
        !value.startsWith('/') &&
        !/^[A-Za-z]:[\\/]/.test(value) &&
        !value.replaceAll('\\', '/').split('/').includes('..'),
      'Git Skill path must be repository-relative',
    ),
  expectedContentHash: contentHashSchema,
  // SOURCE LOCATOR for update checks (P2): the Git ref this reference tracks (e.g.
  // `refs/heads/release`), distinct from the exact approved `revision`. Optional/back-compat:
  // absent = exact-commit-pinned reference, not update-trackable. Reacquisition always uses the
  // exact `revision`; only source-latest re-resolves this ref.
  ref: z.string().min(1).optional(),
});

export const referenceRestorationSchema = z.object({
  strategy: z.literal('reference'),
  reference: referenceRecordSchema,
});

export const snapshotRestorationSchema = z.object({
  strategy: z.literal('snapshot'),
  snapshotId: snapshotIdSchema,
  reason: snapshotReasonSchema,
});

export const restorationStrategySchema = z.discriminatedUnion('strategy', [
  referenceRestorationSchema,
  snapshotRestorationSchema,
]);

export const localContentRecordSchema = z.object({
  available: z.literal(true),
  contentHash: contentHashSchema,
});

export const snapshotRecordSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: snapshotIdSchema,
  environmentEntryId: z.string().regex(/^skill_[A-Za-z0-9_-]{8,}$/),
  contentHash: contentHashSchema,
  createdAt: z.iso.datetime({ offset: true }),
  reason: snapshotReasonSchema,
});

export const preservationStateSchema = z.enum([
  'available',
  'missing',
  'corrupt',
]);
export const storeVerificationSchema = z.object({
  state: preservationStateSchema,
  contentHash: contentHashSchema,
  code: z.string().optional(),
  message: z.string().optional(),
  objectPath: z.string().optional(),
});

export type ContentStoreMetadata = z.infer<typeof contentStoreMetadataSchema>;
export type ReferenceRecord = z.infer<typeof referenceRecordSchema>;
export type ReferenceRestoration = z.infer<typeof referenceRestorationSchema>;
export type SnapshotRestoration = z.infer<typeof snapshotRestorationSchema>;
export type RestorationStrategy = z.infer<typeof restorationStrategySchema>;
export type LocalContentRecord = z.infer<typeof localContentRecordSchema>;
export type SnapshotRecord = z.infer<typeof snapshotRecordSchema>;
export type SnapshotReason = z.infer<typeof snapshotReasonSchema>;
export type PreservationState = z.infer<typeof preservationStateSchema>;
export type StoreVerification = z.infer<typeof storeVerificationSchema>;
