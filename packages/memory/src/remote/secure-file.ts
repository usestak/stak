/**
 * Atomic, owner-only file writes for private Memory key/state files.
 *
 * The same tmp-file + rename + mode 0o600 pattern used by the content-addressed
 * store, centralized here for the remote/key modules. Phase 14A's store.ts and
 * restore.ts keep their own copies unchanged (this file only serves new code).
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Create a directory (recursive). */
export const secureMkdir = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true });
};

/**
 * Write bytes atomically with restrictive permissions: a temp sibling is written
 * (mode 0o600) then renamed over the target, so readers never see a partial file
 * and the file never exists world-readable. Cleans up the temp file on failure.
 */
export const atomicWriteFile = async (
  target: string,
  bytes: Uint8Array,
  options: { mode?: number } = {},
): Promise<void> => {
  await secureMkdir(path.dirname(target));
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, { mode: options.mode ?? 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};
