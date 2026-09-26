/**
 * Atomic, owner-only file writes for private Memory key/state files.
 *
 * The same tmp-file + rename + mode 0o600 pattern used by the content-addressed
 * store, centralized here for the remote/key modules. Phase 14A's store.ts and
 * restore.ts keep their own copies unchanged (this file only serves new code).
 */
import { execFile } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Create a directory (recursive). */
export const secureMkdir = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true });
};

/**
 * Best-effort owner-only hardening for a directory tree.
 *
 * On POSIX the files are already owner-only via mode 0o600 (see atomicWriteFile),
 * so this is a no-op. On Windows, Node's `mode` does NOT set NTFS ACLs — files
 * inherit the parent directory's ACL, which can grant other principals read access.
 * This uses the built-in `icacls` tool (no dependency) to break inheritance and
 * grant Full control to the current user's SID only. It is best-effort: any failure
 * is swallowed (Administrators/SYSTEM always retain access on Windows, and the V0
 * threat model does not defend against local-OS-account compromise). Returns whether
 * hardening was applied.
 */
export const hardenOwnerOnly = async (directory: string): Promise<boolean> => {
  if (process.platform !== 'win32') return false;
  // Use absolute System32 paths so a shell's PATH (e.g. Git Bash's Unix `whoami`)
  // cannot shadow the real Windows tools.
  const system32 = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
  );
  try {
    const { stdout } = await execFileAsync(path.join(system32, 'whoami.exe'), [
      '/user',
      '/fo',
      'csv',
      '/nh',
    ]);
    const sid = stdout.trim().split(',').pop()?.replace(/"/g, '').trim();
    if (!sid || !/^S-1-/.test(sid)) return false;
    await execFileAsync(path.join(system32, 'icacls.exe'), [
      directory,
      '/inheritance:r',
      '/grant:r',
      `*${sid}:(OI)(CI)F`,
      '/t',
      '/q',
    ]);
    return true;
  } catch {
    // Best-effort only: never block enrollment on ACL hardening.
    return false;
  }
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
