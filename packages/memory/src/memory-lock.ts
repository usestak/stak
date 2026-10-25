import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { link, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
      typeof value.hostname === 'string' &&
      typeof value.startedAt === 'string' &&
      typeof value.command === 'string'
    )
      return value as MemoryLockRecord;
  } catch {
    // fall through
  }
  return undefined;
};

/** null = no lock; 'corrupt' = a lock file exists but cannot be read as a record. */
export const readMemoryLock = async (stackHome: string): Promise<MemoryLockRecord | 'corrupt' | null> => {
  let text: string;
  try {
    text = await readFile(memoryLockPath(stackHome), 'utf8');
  } catch (error) {
    if (errno(error) === 'ENOENT') return null;
    throw error;
  }
  return parseRecord(text) ?? 'corrupt';
};

/** Atomic create-with-content: write a private temp file, then hard-link it into place (fails with EEXIST if held). */
const tryCreate = async (stackHome: string, record: MemoryLockRecord): Promise<boolean> => {
  const target = memoryLockPath(stackHome);
  const temporary = `${target}.${record.lockId}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  try {
    await link(temporary, target);
    return true;
  } catch (error) {
    if (errno(error) === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
};

const removeIfLockId = async (stackHome: string, lockId: string): Promise<boolean> => {
  const current = await readMemoryLock(stackHome);
  if (current === null || current === 'corrupt' || current.lockId !== lockId) return false;
  await rm(memoryLockPath(stackHome), { force: true });
  return true;
};

const removeStaleGuard = async (stackHome: string, guardStaleMs: number): Promise<void> => {
  try {
    const info = await stat(guardPath(stackHome));
    if (Date.now() - info.mtimeMs > guardStaleMs) await rm(guardPath(stackHome), { force: true });
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
};

/** Clear `inspected` only while holding the guard, and only if the lock is still that same leftover. */
const clearLeftover = async (
  stackHome: string,
  inspected: MemoryLockRecord,
  options: { guardStaleMs: number; onLeftoverCleared?: ((holder: MemoryLockRecord) => void) | undefined },
): Promise<void> => {
  let guard;
  try {
    guard = await open(guardPath(stackHome), 'wx');
  } catch (error) {
    if (errno(error) !== 'EEXIST') throw error;
    await removeStaleGuard(stackHome, options.guardStaleMs);
    return;
  }
  try {
    if (await removeIfLockId(stackHome, inspected.lockId)) options.onLeftoverCleared?.(inspected);
  } finally {
    await guard.close();
    await rm(guardPath(stackHome), { force: true });
  }
};

const ago = (startedAt: string, now: Date): string => {
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(startedAt)) / 1000));
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
};

export const busyMessage = (holder: MemoryLockRecord, now: Date = new Date()): string =>
  `Another STAK command (\`${holder.command}\`, started ${ago(holder.startedAt, now)} ago) is changing Memory. Try again when it finishes.`;

export const leftoverClearedMessage = (holder: MemoryLockRecord): string =>
  `Cleared a leftover Memory lock from \`${holder.command}\` (process ${holder.pid}, no longer running).`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const record: MemoryLockRecord = {
    lockId: randomUUID(),
    pid: options.pid ?? process.pid,
    hostname: host,
    startedAt: now().toISOString(),
    command,
  };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryCreate(stackHome, record)) break;
    const holder = await readMemoryLock(stackHome);
    if (holder === null) continue; // released between our attempt and our read
    if (holder !== 'corrupt' && holder.hostname === host && !alive(holder.pid)) {
      await clearLeftover(stackHome, holder, { guardStaleMs, onLeftoverCleared: options.onLeftoverCleared });
      continue;
    }
    if (Date.now() >= deadline) {
      if (holder === 'corrupt')
        throw new MemoryLockError(
          'Another STAK command is changing Memory (its lock file is unreadable). Try again when it finishes, or run `stak memory unlock`.',
        );
      throw new MemoryLockError(busyMessage(holder, now()), holder);
    }
    await sleep(pollMs);
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
