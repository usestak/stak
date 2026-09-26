/**
 * Atomic, owner-only file writes for private Memory key/state files.
 *
 * The same tmp-file + rename + mode 0o600 pattern used by the content-addressed
 * store, centralized here for the remote/key modules. Phase 14A's store.ts and
 * restore.ts keep their own copies unchanged (this file only serves new code).
 */
import { execFile } from 'node:child_process';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const system32Path = (exe: string): string =>
  path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe);

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
  try {
    const { stdout } = await execFileAsync(system32Path('whoami.exe'), [
      '/user',
      '/fo',
      'csv',
      '/nh',
    ]);
    const sid = stdout.trim().split(',').pop()?.replace(/"/g, '').trim();
    if (!sid || !/^S-1-/.test(sid)) return false;
    await execFileAsync(system32Path('icacls.exe'), [
      directory,
      '/inheritance:r',
      '/grant:r',
      `*${sid}:(OI)(CI)F`,
      '/t',
      '/q',
    ]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Verify that key material is readable ONLY by the current user (no accidental
 * access by unrelated local principals). This is the fail-closed check enrollment
 * relies on — it does not defend against a compromised local OS account.
 *
 *  - POSIX: every file must be mode 0o600 (no group/other bits).
 *  - Windows: the keys directory's DACL, after hardening, must have exactly one
 *    (non-inherited) principal ACE — the current user we just granted — with no
 *    remaining inherited ACEs. SID/name display is not parsed (locale-agnostic);
 *    we assert structure: inheritance removed + a single principal.
 *
 * Returns false (fail-closed) on any inability to verify.
 */
export const verifyOwnerOnly = async (options: {
  keysDir: string;
  files: string[];
  platform?: NodeJS.Platform;
}): Promise<boolean> => {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(system32Path('icacls.exe'), [
        options.keysDir,
      ]);
      const aceLines = stdout.split(/\r?\n/).filter((line) => /:\(/.test(line));
      const hasInheritedAce = /\(I\)/.test(stdout);
      return aceLines.length === 1 && !hasInheritedAce;
    } catch {
      return false;
    }
  }
  try {
    for (const file of options.files) {
      const info = await stat(file);
      if ((info.mode & 0o077) !== 0) return false;
    }
    return true;
  } catch {
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
