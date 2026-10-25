import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import path from 'node:path';

export type MemoryLockRecord = {
  lockId: string;
  pid: number;
  hostname: string;
  startedAt: string;
  command: string;
};

export class MemoryLockError extends Error {
  readonly code = 'memory-locked' as const;
  constructor(message: string, readonly holder?: MemoryLockRecord) {
    super(message);
    this.name = 'MemoryLockError';
  }
}

export type MemoryLockOptions = {
  timeoutMs?: number;
  pollMs?: number;
  guardStaleMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  hostname?: string;
  pid?: number;
  now?: () => Date;
  onLeftoverCleared?: (holder: MemoryLockRecord) => void;
  installSignalHandlers?: boolean;
};

export type UnlockResult =
  | { status: 'no-lock' }
  | { status: 'removed'; holder: MemoryLockRecord | 'corrupt'; wasAlive: boolean }
  | { status: 'refused'; holder: MemoryLockRecord };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 200;
const DEFAULT_GUARD_STALE_MS = 30_000;

export const memoryLockPath = (stackHome: string): string => path.join(stackHome, 'memory', '.memory.lock');
const guardPath = (stackHome: string): string => path.join(stackHome, 'memory', '.memory.lock.clearing');

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** EPERM means the process exists but belongs to another user, so it is alive. */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) === 'EPERM';
  }
};

const parseRecord = (text: string): MemoryLockRecord | undefined => {
  try {
    const value = JSON.parse(text) as Partial<MemoryLockRecord>;
    if (
      typeof value.lockId === 'string' &&
      typeof value.pid === 'number' &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.hostname === 'string' &&
      typeof value.startedAt === 'string' &&
      Number.isFinite(Date.parse(value.startedAt)) &&
      typeof value.command === 'string'
    )
      return value as MemoryLockRecord;
  } catch {
    // fall through
  }
  return undefined;
};

/**
 * Windows: a file that another process just deleted stays "delete pending" for a moment, and
 * opening, linking or creating it then fails with EPERM/EACCES/EBUSY instead of ENOENT/EEXIST.
 * These codes mean "busy, look again shortly".
 */
const isTransient = (error: unknown): boolean => {
  const code = errno(error);
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One read of the raw lock bytes: null = no lock; 'busy' = transiently unreadable (see isTransient). */
const readLockBytes = async (stackHome: string): Promise<Buffer | null | 'busy'> => {
  try {
    return await readFile(memoryLockPath(stackHome));
  } catch (error) {
    if (errno(error) === 'ENOENT') return null;
    if (isTransient(error)) return 'busy';
    throw error;
  }
};

const READ_RETRIES = 20;
const READ_RETRY_MS = 25;

/**
 * null = no lock; 'corrupt' = a lock file exists but cannot be read as a record.
 * Retries briefly (about 0.5 s) through a transient delete-pending window before giving up.
 */
export const readMemoryLock = async (stackHome: string): Promise<MemoryLockRecord | 'corrupt' | null> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const text = await readFile(memoryLockPath(stackHome), 'utf8');
      return parseRecord(text) ?? 'corrupt';
    } catch (error) {
      if (errno(error) === 'ENOENT') return null;
      if (!isTransient(error) || attempt >= READ_RETRIES) throw error;
      await sleep(READ_RETRY_MS);
    }
  }
};

/** Best-effort removal; never throws. */
const rmQuiet = async (target: string): Promise<void> => {
  try {
    await rm(target, { force: true });
  } catch {
    // best effort
  }
};

/**
 * Atomic create-with-content: write a private temp file, then hard-link it into place.
 * 'held' = a lock exists (EEXIST); 'busy' = transient Windows delete-pending error, retry.
 */
const tryCreate = async (stackHome: string, record: MemoryLockRecord): Promise<'acquired' | 'held' | 'busy'> => {
  const target = memoryLockPath(stackHome);
  const temporary = `${target}.${record.lockId}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    try {
      await link(temporary, target);
      return 'acquired';
    } catch (error) {
      if (errno(error) === 'EEXIST') return 'held';
      if (isTransient(error)) return 'busy';
      throw error;
    }
  } finally {
    // Best effort, so a failure here can never mask a successful link.
    await rmQuiet(temporary);
  }
};

const TMP_STALE_MS = 60_000;

/** Best-effort sweep of `.memory.lock.<id>.tmp` files orphaned by a hard-killed process. */
const sweepStaleTemps = async (stackHome: string): Promise<void> => {
  try {
    const dir = path.dirname(memoryLockPath(stackHome));
    for (const name of await readdir(dir)) {
      if (!name.startsWith('.memory.lock.') || !name.endsWith('.tmp')) continue;
      try {
        const info = await stat(path.join(dir, name));
        if (Date.now() - info.mtimeMs > TMP_STALE_MS) await rmQuiet(path.join(dir, name));
      } catch {
        // gone or busy: skip
      }
    }
  } catch {
    // best effort
  }
};

/**
 * Remove the lock only if it still carries `lockId`.
 *
 * Known remaining race: this is read-then-rm, not atomic. Acquire's leftover clearing runs it
 * under the guard, but release and `unlockMemory` take no guard, so in a narrow window the file
 * can be replaced between the read and the rm. Release only targets its own live lock (nobody
 * else may replace it), so the practical exposure is `unlockMemory` racing a fresh acquire.
 */
const removeIfLockId = async (stackHome: string, lockId: string): Promise<boolean> => {
  const current = await readMemoryLock(stackHome);
  if (current === null || current === 'corrupt' || current.lockId !== lockId) return false;
  await rm(memoryLockPath(stackHome), { force: true });
  return true;
};

/** Rename a stale guard to a unique name first, so exactly one remover wins, then delete the renamed file. */
const removeStaleGuard = async (stackHome: string, guardStaleMs: number): Promise<void> => {
  const guard = guardPath(stackHome);
  try {
    const info = await stat(guard);
    if (Date.now() - info.mtimeMs <= guardStaleMs) return;
    const claimed = `${guard}.${randomUUID()}.stale`;
    await rename(guard, claimed);
    await rmQuiet(claimed);
  } catch (error) {
    if (errno(error) !== 'ENOENT' && !isTransient(error)) throw error;
  }
};

/**
 * Run `fn` while holding the clearing guard. Returns false without running it when the guard is
 * held by someone else (after removing that guard if it is stale) or is transiently busy.
 */
const underGuard = async (stackHome: string, guardStaleMs: number, fn: () => Promise<boolean>): Promise<boolean> => {
  const guard = guardPath(stackHome);
  const token = randomUUID();
  let handle;
  try {
    handle = await open(guard, 'wx');
  } catch (error) {
    if (errno(error) === 'EEXIST') {
      await removeStaleGuard(stackHome, guardStaleMs);
      return false;
    }
    if (isTransient(error)) return false;
    throw error;
  }
  try {
    await handle.writeFile(token);
  } catch {
    // the token is only a safety check on removal
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    // Remove the guard only if it is still ours (it could have been reclaimed as stale).
    try {
      if ((await readFile(guard, 'utf8')) === token) await rmQuiet(guard);
    } catch {
      // gone or busy
    }
  }
};

/** Clear `inspected` only while holding the guard, and only if the lock is still that same leftover. Returns whether it cleared it. */
const clearLeftover = async (
  stackHome: string,
  inspected: MemoryLockRecord,
  options: { guardStaleMs: number; onLeftoverCleared?: ((holder: MemoryLockRecord) => void) | undefined },
): Promise<boolean> =>
  underGuard(stackHome, options.guardStaleMs, async () => {
    if (!(await removeIfLockId(stackHome, inspected.lockId))) return false;
    options.onLeftoverCleared?.(inspected);
    return true;
  });

/** Clear a corrupt lock only while holding the guard, and only if its bytes are unchanged. Returns whether it cleared it. */
const clearCorrupt = async (stackHome: string, inspected: Buffer, guardStaleMs: number): Promise<boolean> =>
  underGuard(stackHome, guardStaleMs, async () => {
    const current = await readLockBytes(stackHome);
    if (!Buffer.isBuffer(current) || !current.equals(inspected)) return false;
    await rm(memoryLockPath(stackHome), { force: true });
    return true;
  });

const ago = (startedAt: string, now: Date): string => {
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(startedAt)) / 1000));
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
};

export const busyMessage = (holder: MemoryLockRecord, now: Date = new Date()): string =>
  `Another STAK command (\`${holder.command}\`, started ${ago(holder.startedAt, now)} ago) is changing Memory. Try again when it finishes.`;

export const leftoverClearedMessage = (holder: MemoryLockRecord): string =>
  `Cleared a leftover Memory lock from \`${holder.command}\` (process ${holder.pid}, no longer running).`;

const CORRUPT_MESSAGE =
  'Another STAK command is changing Memory (its lock file is unreadable). Try again when it finishes, or run `stak memory unlock`.';
const UNKNOWN_HOLDER_MESSAGE = 'Another STAK command is changing Memory. Try again when it finishes.';

export const acquireMemoryLock = async (
  stackHome: string,
  command: string,
  options: MemoryLockOptions = {},
): Promise<{ record: MemoryLockRecord; release(): Promise<void> }> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const guardStaleMs = options.guardStaleMs ?? DEFAULT_GUARD_STALE_MS;
  const alive = options.isProcessAlive ?? isProcessAlive;
  const host = options.hostname ?? osHostname();
  const now = options.now ?? (() => new Date());

  await mkdir(path.dirname(memoryLockPath(stackHome)), { recursive: true });
  await sweepStaleTemps(stackHome);
  const record: MemoryLockRecord = {
    lockId: randomUUID(),
    pid: options.pid ?? process.pid,
    hostname: host,
    startedAt: now().toISOString(),
    command,
  };

  const deadline = Date.now() + timeoutMs;
  let lastHolder: MemoryLockRecord | 'corrupt' | undefined;
  for (;;) {
    const created = await tryCreate(stackHome, record);
    if (created === 'acquired') break;
    // retryNow = progress was made (lock vanished or was cleared), so skip the sleep; the deadline still applies.
    let retryNow = false;
    if (created === 'held') {
      const bytes = await readLockBytes(stackHome);
      if (bytes === null) {
        retryNow = true; // released between our attempt and our read
      } else if (bytes !== 'busy') {
        const holder = parseRecord(bytes.toString('utf8')) ?? 'corrupt';
        lastHolder = holder;
        if (holder !== 'corrupt') {
          if (holder.hostname === host && !alive(holder.pid))
            retryNow = await clearLeftover(stackHome, holder, { guardStaleMs, onLeftoverCleared: options.onLeftoverCleared });
        } else {
          try {
            const info = await stat(memoryLockPath(stackHome));
            if (Date.now() - info.mtimeMs > guardStaleMs) retryNow = await clearCorrupt(stackHome, bytes, guardStaleMs);
          } catch (error) {
            if (errno(error) === 'ENOENT') retryNow = true;
            else if (!isTransient(error)) throw error;
          }
        }
      }
    }
    if (Date.now() >= deadline) {
      if (lastHolder === 'corrupt') throw new MemoryLockError(CORRUPT_MESSAGE);
      if (lastHolder) throw new MemoryLockError(busyMessage(lastHolder, now()), lastHolder);
      throw new MemoryLockError(UNKNOWN_HOLDER_MESSAGE);
    }
    if (!retryNow) await sleep(pollMs);
  }

  const lockPath = memoryLockPath(stackHome);
  const releaseSync = () => {
    try {
      const current = parseRecord(readFileSync(lockPath, 'utf8'));
      if (current?.lockId === record.lockId) unlinkSync(lockPath);
    } catch {
      // already gone or unreadable: nothing of ours to remove
    }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    releaseSync();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const install = options.installSignalHandlers ?? true;
  if (install) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  let released = false;
  return {
    record,
    release: async () => {
      if (released) return;
      released = true;
      if (install) {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
      await removeIfLockId(stackHome, record.lockId);
    },
  };
};

export const withMemoryLock = async <T>(
  stackHome: string,
  command: string,
  fn: () => Promise<T>,
  options: MemoryLockOptions = {},
): Promise<T> => {
  const lock = await acquireMemoryLock(stackHome, command, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
};

export const unlockMemory = async (
  stackHome: string,
  options: { force?: boolean; isProcessAlive?: (pid: number) => boolean; hostname?: string } = {},
): Promise<UnlockResult> => {
  const holder = await readMemoryLock(stackHome);
  if (holder === null) return { status: 'no-lock' };
  if (holder === 'corrupt') {
    await rm(memoryLockPath(stackHome), { force: true });
    return { status: 'removed', holder, wasAlive: false };
  }
  const host = options.hostname ?? osHostname();
  const alive = holder.hostname !== host || (options.isProcessAlive ?? isProcessAlive)(holder.pid);
  if (alive && options.force !== true) return { status: 'refused', holder };
  await removeIfLockId(stackHome, holder.lockId);
  return { status: 'removed', holder, wasAlive: alive };
};
