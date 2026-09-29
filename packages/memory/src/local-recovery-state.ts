import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { atomicWriteFile } from './remote/secure-file.js';
import { memoryStorePaths } from './store.js';

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
