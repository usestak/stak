import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { MemoryManifest } from './domain.js';
import { atomicWriteFile } from './remote/secure-file.js';
import { hashBytes, memoryStorePaths } from './store.js';

/**
 * Machine-local recovery provenance (Phase 15B.6).
 *
 * Records which Cloud Memory generation the local private store was recovered from,
 * so `stack memory status` can distinguish "recovered from the latest generation"
 * from "deliberately recovered from an earlier historical generation", and so a
 * subsequent backup can warn before superseding a newer Cloud generation.
 *
 * It is NON-SECRET machine-local metadata: it never enters a Memory bundle, never
 * becomes public, never crosses machines as identity, and holds no Memory contents
 * or cryptographic material. It lives only under STACK_HOME.
 */
export const LOCAL_RECOVERY_STATE_VERSION = 1 as const;

export const localRecoveryStateSchema = z.object({
  schemaVersion: z.literal(LOCAL_RECOVERY_STATE_VERSION),
  recoveredGeneration: z.number().int().nonnegative(),
  cloudLatestAtRecovery: z.number().int().nonnegative().nullable(),
  recoveredAt: z.iso.datetime({ offset: true }),
  privacyMode: z.enum(['standard', 'protected']),
  /**
   * Semantic digest (hash of the canonical, PRE-ENCRYPTION bundle bytes `bundleFromStore`
   * produces) of the staged Memory state that now corresponds to `recoveredGeneration`.
   * Lets a later `stak push` detect "staged content is unchanged since the last push" —
   * essential for Protected mode, where the uploaded ciphertext is randomized per backup
   * and can never be compared directly. Optional for backward compatibility with state
   * written before this field existed; its absence just means that optimization can't be
   * made (callers must not treat it as "unchanged").
   */
  semanticDigest: z.string().optional(),
  /**
   * Task 13 fix round 3: written ONLY by a Cloud recover (never by a push) —
   * the `v1ManifestFingerprint` of the v1 manifest that recover just restored.
   * Migration compares it with the manifest it is about to migrate: a match
   * means "this manifest came from Cloud and nothing was added locally since",
   * so this machine's native files can't be assumed to hold it. Absent (any
   * push, or any state written by an older CLI) means the manifest is treated
   * as locally produced.
   */
  recoveredManifestFingerprint: z.string().optional(),
});
export type LocalRecoveryState = z.infer<typeof localRecoveryStateSchema>;

export class LocalRecoveryStateError extends Error {
  constructor(
    public readonly code: 'corrupt',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LocalRecoveryStateError';
  }
}

/** Stable fingerprint of a (schema-parsed) v1 manifest — see
 * `recoveredManifestFingerprint`. */
export const v1ManifestFingerprint = (manifest: MemoryManifest): string =>
  hashBytes(Buffer.from(JSON.stringify(manifest), 'utf8'));

/** Read the local recovery provenance, or null when none has been recorded. */
export const readLocalRecoveryState = async (
  stackHome: string,
): Promise<LocalRecoveryState | null> => {
  const file = memoryStorePaths(stackHome).recoveryState;
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return localRecoveryStateSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new LocalRecoveryStateError(
      'corrupt',
      'The local recovery-state file is malformed.',
      { cause: error },
    );
  }
};

/** Persist the local recovery provenance atomically. */
export const writeLocalRecoveryState = async (
  stackHome: string,
  state: LocalRecoveryState,
): Promise<void> => {
  await atomicWriteFile(
    memoryStorePaths(stackHome).recoveryState,
    Buffer.from(
      `${JSON.stringify(localRecoveryStateSchema.parse(state), null, 2)}\n`,
      'utf8',
    ),
  );
};

/**
 * Whether the local state was recovered from an OLDER generation than the current
 * Cloud latest — i.e. a subsequent backup would supersede a newer Cloud generation.
 */
export const isHistoricalRecovery = (
  state: LocalRecoveryState | null,
  cloudLatestGeneration: number | null,
): boolean =>
  state !== null &&
  cloudLatestGeneration !== null &&
  state.recoveredGeneration < cloudLatestGeneration;
