# Memory Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop concurrent STAK commands from interleaving changes to the local Memory store, using one cross-process Memory lock per STAK home (spec `docs/superpowers/specs/2026-10-25-memory-lock-design.md`).

**Architecture:** A self-contained lock module in `@stack/memory` provides `withMemoryLock`, `acquireMemoryLock`, `readMemoryLock` and `unlockMemory`. It works like this:
- The lock is created atomically (temp file + hard link, which fails if the lock already exists).
- A waiting command polls until it gets the lock or times out.
- A leftover lock is cleared only under a guard file.
- Release goes through a `lockId` ownership check.
- Signal handlers release the lock on interrupt.

Each CLI command that changes Memory receives an optional `withMemoryLock` dependency (wired in `program.ts`) and wraps its Memory section at the top-level action. Inner functions never take the lock.

**Tech Stack:** TypeScript, Node `fs/promises`, vitest, commander. pnpm monorepo: `@stack/memory` (packages/memory), `@memstk/cli` (packages/cli), `@stack/core` (packages/core).

## Global Constraints

- Lock file: `<stackHome>/memory/.memory.lock`. Guard file: `<stackHome>/memory/.memory.lock.clearing`.
- Lock record fields, exactly: `lockId`, `pid`, `hostname`, `startedAt`, `command`.
- Poll every 200 ms. Wait timeout 10 s. A guard file older than 30 s is a leftover.
- Busy message, exactly: `` Another STAK command (`<command>`, started <ago> ago) is changing Memory. Try again when it finishes. ``
- Leftover-cleared note, exactly: `` Cleared a leftover Memory lock from `<command>` (process <pid>, no longer running). ``
- Release and every removal path remove the lock only if its `lockId` matches the expected one. Never unlink the path blindly.
- Never clear a lock automatically when its `hostname` differs from this machine's, or when its `pid` is alive.
- Error code for the busy timeout: `memory-locked`.
- Only top-level command actions take the lock. Inner functions never do.
- The lock file is excluded from Cloud and Stack bundles.
- Run `pnpm -w build` once before running tests, because packages import each other's `dist/`. Ignore the `@stack/web` build failure about `STAK_APP_URL`; it predates this work.
- Vitest does not typecheck. Also run `pnpm --filter <pkg> exec tsc --noEmit -p .`.
- Commit with explicit paths only, never `git add .`. End every commit message with:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

---

### Task 1: The lock module in `@stack/memory`

**Files:**
- Create: `packages/memory/src/memory-lock.ts`
- Create: `packages/memory/src/memory-lock.test.ts`
- Create: `packages/memory/src/memory-lock-child.test-helper.mjs` (child-process helper for the race test)
- Modify: `packages/memory/src/index.ts` (export the module)
- Modify: `packages/core/src/state.ts` (add the lock file to `STATE_EXCLUDE_PATHS`)

**Interfaces:**
- Produces:
  - `type MemoryLockRecord = { lockId: string; pid: number; hostname: string; startedAt: string; command: string }`
  - `class MemoryLockError extends Error { code: 'memory-locked'; holder?: MemoryLockRecord }`
  - `memoryLockPath(stackHome: string): string`
  - `isProcessAlive(pid: number): boolean`
  - `readMemoryLock(stackHome: string): Promise<MemoryLockRecord | 'corrupt' | null>`
  - `acquireMemoryLock(stackHome: string, command: string, options?: MemoryLockOptions): Promise<{ record: MemoryLockRecord; release(): Promise<void> }>`
  - `withMemoryLock<T>(stackHome: string, command: string, fn: () => Promise<T>, options?: MemoryLockOptions): Promise<T>`
  - `unlockMemory(stackHome: string, options?: { force?: boolean; isProcessAlive?: (pid: number) => boolean; hostname?: string }): Promise<UnlockResult>`
  - `type UnlockResult = { status: 'no-lock' } | { status: 'removed'; holder: MemoryLockRecord | 'corrupt'; wasAlive: boolean } | { status: 'refused'; holder: MemoryLockRecord }`
  - `type MemoryLockOptions = { timeoutMs?: number; pollMs?: number; guardStaleMs?: number; isProcessAlive?: (pid: number) => boolean; hostname?: string; pid?: number; now?: () => Date; onLeftoverCleared?: (holder: MemoryLockRecord) => void; installSignalHandlers?: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `packages/memory/src/memory-lock.test.ts`:

```ts
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MemoryLockError,
  acquireMemoryLock,
  memoryLockPath,
  readMemoryLock,
  unlockMemory,
  withMemoryLock,
  type MemoryLockRecord,
} from './memory-lock.js';

const roots: string[] = [];
const temp = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'stak-memlock-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const fast = { timeoutMs: 600, pollMs: 20, installSignalHandlers: false } as const;

const plant = async (stackHome: string, record: Partial<MemoryLockRecord> = {}): Promise<MemoryLockRecord> => {
  const full: MemoryLockRecord = {
    lockId: 'planted-lock',
    pid: 999_999,
    hostname: 'this-host',
    startedAt: new Date(Date.now() - 12_000).toISOString(),
    command: 'stak pull',
    ...record,
  };
  await mkdir(path.dirname(memoryLockPath(stackHome)), { recursive: true });
  await writeFile(memoryLockPath(stackHome), JSON.stringify(full));
  return full;
};

describe('withMemoryLock', () => {
  it('takes the lock for the duration of fn and releases it afterwards', async () => {
    const stackHome = await temp();
    let seen: unknown;
    const result = await withMemoryLock(stackHome, 'stak add', async () => {
      seen = await readMemoryLock(stackHome);
      return 42;
    }, fast);
    expect(result).toBe(42);
    expect(seen).toMatchObject({ command: 'stak add', pid: process.pid });
    expect(await readMemoryLock(stackHome)).toBeNull();
  });

  it('releases the lock when fn throws', async () => {
    const stackHome = await temp();
    await expect(withMemoryLock(stackHome, 'stak add', async () => { throw new Error('boom'); }, fast)).rejects.toThrow('boom');
    expect(await readMemoryLock(stackHome)).toBeNull();
  });

  it('release never removes a lock whose lockId is not its own', async () => {
    const stackHome = await temp();
    const lock = await acquireMemoryLock(stackHome, 'stak add', fast);
    await plant(stackHome, { lockId: 'someone-else', pid: process.pid, hostname: lock.record.hostname });
    await lock.release();
    expect(await readMemoryLock(stackHome)).toMatchObject({ lockId: 'someone-else' });
  });

  it('serializes two holders in the same process', async () => {
    const stackHome = await temp();
    const order: string[] = [];
    const slow = (name: string) =>
      withMemoryLock(stackHome, name, async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 80));
        order.push(`${name}:end`);
      }, { ...fast, timeoutMs: 2_000 });
    await Promise.all([slow('a'), slow('b')]);
    expect(order[1]).toMatch(/:end$/);
    expect(order[2]).toMatch(/:start$/);
  });

  it('waits, then stops with memory-locked and the exact message when a live holder keeps it', async () => {
    const stackHome = await temp();
    await plant(stackHome, { pid: process.pid, hostname: 'this-host' });
    const error = await withMemoryLock(stackHome, 'stak add', async () => 'never', {
      ...fast,
      hostname: 'this-host',
      isProcessAlive: () => true,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoryLockError);
    expect((error as MemoryLockError).code).toBe('memory-locked');
    expect((error as MemoryLockError).message).toMatch(
      /^Another STAK command \(`stak pull`, started \d+s ago\) is changing Memory\. Try again when it finishes\.$/,
    );
    expect(await readMemoryLock(stackHome)).toMatchObject({ lockId: 'planted-lock' });
  });

  it('clears a leftover lock whose process is gone on this machine, and reports it', async () => {
    const stackHome = await temp();
    await plant(stackHome, { hostname: 'this-host' });
    const cleared: MemoryLockRecord[] = [];
    await withMemoryLock(stackHome, 'stak add', async () => undefined, {
      ...fast,
      hostname: 'this-host',
      isProcessAlive: () => false,
      onLeftoverCleared: (h) => cleared.push(h),
    });
    expect(cleared.map((h) => h.lockId)).toEqual(['planted-lock']);
  });

  it('never clears a lock recorded on a different machine', async () => {
    const stackHome = await temp();
    await plant(stackHome, { hostname: 'other-host' });
    await expect(
      withMemoryLock(stackHome, 'stak add', async () => undefined, { ...fast, hostname: 'this-host', isProcessAlive: () => false }),
    ).rejects.toMatchObject({ code: 'memory-locked' });
    expect(await readMemoryLock(stackHome)).toMatchObject({ lockId: 'planted-lock' });
  });

  it('removes a guard file older than guardStaleMs, then clears the leftover', async () => {
    const stackHome = await temp();
    await plant(stackHome, { hostname: 'this-host' });
    const guard = path.join(stackHome, 'memory', '.memory.lock.clearing');
    await writeFile(guard, '');
    const old = new Date(Date.now() - 60_000);
    await utimes(guard, old, old);
    await withMemoryLock(stackHome, 'stak add', async () => undefined, {
      ...fast,
      hostname: 'this-host',
      isProcessAlive: () => false,
      guardStaleMs: 30_000,
    });
    expect(await readMemoryLock(stackHome)).toBeNull();
  });

  it('two processes racing to clear the same leftover: exactly one runs at a time and both finish', async () => {
    const stackHome = await temp();
    // Use this machine's real hostname so the children treat it as a local leftover.
    const { hostname } = await import('node:os');
    await plant(stackHome, { hostname: hostname(), pid: 999_999 });
    const helper = fileURLToPath(new URL('./memory-lock-child.test-helper.mjs', import.meta.url));
    const log = path.join(stackHome, 'log.txt');
    const run = (name: string) =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [helper, stackHome, name, log], { stdio: 'inherit' });
        child.on('exit', (code) => resolve(code ?? 1));
      });
    const codes = await Promise.all([run('a'), run('b')]);
    expect(codes).toEqual([0, 0]);
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(4);
    // Critical sections never overlap: start/end pairs are adjacent.
    expect(lines[0]!.split(':')[0]).toBe(lines[1]!.split(':')[0]);
    expect(lines[2]!.split(':')[0]).toBe(lines[3]!.split(':')[0]);
    expect(await readMemoryLock(stackHome)).toBeNull();
  });

  // Windows cannot deliver SIGINT to a child process (child.kill terminates it outright), so this runs on POSIX only.
  it.skipIf(process.platform === 'win32')('a holder interrupted with SIGINT removes its own lock', async () => {
    const stackHome = await temp();
    const helper = fileURLToPath(new URL('./memory-lock-child.test-helper.mjs', import.meta.url));
    const child = spawn(process.execPath, [helper, stackHome, 'sig', path.join(stackHome, 'log.txt'), 'hold'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((resolve) => child.stdout!.on('data', (d) => String(d).includes('ready') && resolve()));
    expect(await readMemoryLock(stackHome)).toMatchObject({ command: 'child sig' });
    const code = await new Promise<number | null>((resolve) => {
      child.on('exit', (c) => resolve(c));
      child.kill('SIGINT');
    });
    expect(code).toBe(130);
    expect(await readMemoryLock(stackHome)).toBeNull();
  });
});

describe('unlockMemory', () => {
  it('reports no-lock when there is none', async () => {
    expect(await unlockMemory(await temp())).toEqual({ status: 'no-lock' });
  });

  it('removes a lock whose process is not running', async () => {
    const stackHome = await temp();
    await plant(stackHome, { hostname: 'this-host' });
    const result = await unlockMemory(stackHome, { hostname: 'this-host', isProcessAlive: () => false });
    expect(result).toMatchObject({ status: 'removed', wasAlive: false });
    expect(await readMemoryLock(stackHome)).toBeNull();
  });

  it('refuses when the recorded process is running, and --force removes it', async () => {
    const stackHome = await temp();
    await plant(stackHome, { hostname: 'this-host' });
    expect(await unlockMemory(stackHome, { hostname: 'this-host', isProcessAlive: () => true })).toMatchObject({ status: 'refused' });
    expect(await readMemoryLock(stackHome)).toMatchObject({ lockId: 'planted-lock' });
    expect(await unlockMemory(stackHome, { hostname: 'this-host', isProcessAlive: () => true, force: true })).toMatchObject({
      status: 'removed',
      wasAlive: true,
    });
    expect(await readMemoryLock(stackHome)).toBeNull();
  });

  it('treats a lock from another machine as possibly running (refuses without --force)', async () => {
    const stackHome = await temp();
    await plant(stackHome, { hostname: 'other-host' });
    expect(await unlockMemory(stackHome, { hostname: 'this-host', isProcessAlive: () => false })).toMatchObject({ status: 'refused' });
  });

  it('removes an unreadable lock file', async () => {
    const stackHome = await temp();
    await mkdir(path.dirname(memoryLockPath(stackHome)), { recursive: true });
    await writeFile(memoryLockPath(stackHome), 'not json');
    expect(await unlockMemory(stackHome)).toMatchObject({ status: 'removed', holder: 'corrupt' });
  });
});
```

Create `packages/memory/src/memory-lock-child.test-helper.mjs` (imports the built dist, so `pnpm --filter @stack/memory build` must run before the test):

```js
import { appendFile } from 'node:fs/promises';
import { withMemoryLock } from '../dist/memory-lock.js';

const [stackHome, name, log, mode] = process.argv.slice(2);
if (mode === 'hold') {
  // Signal test: hold the lock with real signal handlers until killed.
  await withMemoryLock(stackHome, `child ${name}`, async () => {
    process.stdout.write('ready\n');
    await new Promise(() => {});
  }, { timeoutMs: 5_000, pollMs: 20 });
} else {
  await withMemoryLock(stackHome, `child ${name}`, async () => {
    await appendFile(log, `${name}:start\n`);
    await new Promise((r) => setTimeout(r, 150));
    await appendFile(log, `${name}:end\n`);
  }, { timeoutMs: 5_000, pollMs: 20, installSignalHandlers: false });
}
```

Before relying on `../dist/memory-lock.js`, check how `packages/memory`'s build lays out `dist/`, and adjust the import path to match.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- --run memory-lock`
Expected: FAIL. `./memory-lock.js` does not exist yet.

- [ ] **Step 3: Implement the module**

Create `packages/memory/src/memory-lock.ts`:

```ts
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
  options: Required<Pick<MemoryLockOptions, 'guardStaleMs'>> & Pick<MemoryLockOptions, 'onLeftoverCleared'>,
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
```

Add to `packages/memory/src/index.ts`, following the existing export style:

```ts
export * from './memory-lock.js';
```

In `packages/core/src/state.ts`, add this to `STATE_EXCLUDE_PATHS`, after the projections line:

```ts
  path.join('memory', '.memory.lock'), // machine-local Memory lock
  path.join('memory', '.memory.lock.clearing'), // machine-local Memory lock guard
```

Then find where Cloud and Stack bundles are built from the STAK home: `packages/memory/src/remote/bundle-codec.ts` `bundleFromStore`, and any `packages/core` bundling that walks `memory/`. Confirm the lock files can't be picked up. If a bundler walks directories without consulting `STATE_EXCLUDE_PATHS`, add the exclusion there, plus a test that a present `.memory.lock` is not bundled.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @stack/memory build && pnpm --filter @stack/memory test -- --run memory-lock && pnpm --filter @stack/memory exec tsc --noEmit -p .`
Expected: all memory-lock tests PASS; tsc is clean. Then run the full `@stack/memory` and `@stack/core` suites. Expect no new failures; `packages/core/src/trial.test.ts` has an unrelated failure that predates this work.

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/memory-lock.ts packages/memory/src/memory-lock.test.ts packages/memory/src/memory-lock-child.test-helper.mjs packages/memory/src/index.ts packages/core/src/state.ts
git commit -m "feat(memory): cross-process Memory lock"
```

---

### Task 2: Wrap every Memory-changing command in the lock

**Files:**
- Modify: `packages/cli/src/commands/add.ts`, `push.ts`, `pull.ts`, `memory.ts` (backup, recover, restore, resolve, materialize, protect), `project.ts` (map, name, archive, unarchive; these write the registry, which spec §1 includes in the store)
- Modify: `packages/cli/src/program.ts` (wire the dependency)
- Modify: `packages/cli/src/ui/*.ts` only if needed to render `MemoryLockError` messages and the leftover note
- Test: the existing per-command test files (`packages/cli/src/program.test.ts` and/or `commands/*.test.ts`, following where each command is tested today)

**Interfaces:**
- Consumes: `withMemoryLock`, `MemoryLockError`, `leftoverClearedMessage` from `@stack/memory` (Task 1).
- Produces: an optional dependency on each affected command's `*CommandDependencies` type:

```ts
  /**
   * Runs `fn` while holding the cross-process Memory lock (spec 2026-10-25).
   * Optional so existing tests keep working; when absent, `fn` runs directly.
   */
  withMemoryLock?<T>(command: string, fn: () => Promise<T>): Promise<T>;
```

- [ ] **Step 1: Write the failing tests**

For each command, add a test using its existing test harness. The test passes a `withMemoryLock` spy that records `command` and calls `fn`. Assert three things:
- the spy is called exactly once, with the exact command string (`'stak add'`, `'stak push'`, `'stak pull'`, `'stak memory backup'`, `'stak memory recover'`, `'stak memory restore'`, `'stak memory resolve'`, `'stak memory materialize'`, `'stak memory protect'`, `'stak project map'`, `'stak project name'`, `'stak project archive'`, `'stak project unarchive'`);
- every Memory dependency of that command (for example `applyCanonicalPull`, `memoryPullPreflight`, `applyMemoryPull`, the push/stage Memory functions) is called inside `fn`;
- read-only commands (`stak status`, `stak memory status`, `stak memory diff`, `stak memory history`, `stak memory scan`, `stak memory resolve` with no arguments, which only lists) do not call the spy.

Example for pull, adapting to the actual harness and names in the existing pull tests:

```ts
it('runs all Memory work for stak pull inside the Memory lock', async () => {
  const events: string[] = [];
  const deps = basePullDeps({
    memoryPullPreflight: async () => { events.push('preflight'); return { eligible: false }; },
    applyCanonicalPull: async () => { events.push('canonical'); return { status: 'up-to-date' } as never; },
    withMemoryLock: async (command, fn) => {
      events.push(`lock:${command}`);
      try { return await fn(); } finally { events.push('unlock'); }
    },
  });
  await runPull(deps, ['pull', '--yes']);
  expect(events).toEqual(['lock:stak pull', 'preflight', 'canonical', 'unlock']);
});
```

Also add one test showing a `MemoryLockError` thrown by `withMemoryLock` stops the Memory part with its message and runs no Memory dependency. For `stak push` and `stak pull`, Skills behaviour stays as today: the Memory part reports FAILED with the lock message, matching how a Memory failure renders now.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @memstk/cli test -- --run`
Expected: the new tests FAIL, because the spy is never called.

- [ ] **Step 3: Implement the wrapping**

In each command action, find the span from the first Memory read to the last Memory write, and wrap exactly that span:

```ts
const lock = dependencies.withMemoryLock ?? (async <T>(_command: string, fn: () => Promise<T>) => fn());
const memoryOutcome = await lock('stak pull', async () => {
  // ...the existing Memory section, unchanged: preflight, recover, canonical pull...
});
```

Rules:
- **Push.** Wrap the Memory part only. The Skills part runs outside the lock, as today.
- **Pull.** The Memory preflight read is inside the lock, so the decision and the action see the same state.
- **Inner functions** (`canonical-ops.ts`, `cloud-ops.ts`, `@stack/memory`) are never changed to take the lock.
- **Interactive confirmations.** Where a Memory command prompts the user (`confirm(...)`) between reading and writing Memory, keep the prompt inside the lock, so the confirmed preview can't go stale. The 10 s wait on other commands is acceptable here: they stop with the busy message rather than hang.

In `packages/cli/src/program.ts`, add this to every affected command's dependency object, using the same `stackHome` the neighbouring entries use:

```ts
withMemoryLock: (command, fn) =>
  withMemoryLock(stackHome, command, fn, {
    onLeftoverCleared: (holder) => writeErr(`${leftoverClearedMessage(holder)}\n`),
  }),
```

Use whatever stderr writer `program.ts` already uses for notes. If none exists, use the command's `writeOut`. Make sure `MemoryLockError` renders as its message without a stack trace, the same way other typed STAK errors are rendered (check how `MemorySyncError` and `StackCompositionError` are surfaced).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @memstk/cli test -- --run && pnpm --filter @memstk/cli exec tsc --noEmit -p .`
Expected: all PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/add.ts packages/cli/src/commands/push.ts packages/cli/src/commands/pull.ts packages/cli/src/commands/memory.ts packages/cli/src/commands/project.ts packages/cli/src/program.ts <touched test and ui files>
git commit -m "feat(cli): hold the Memory lock in every Memory-changing command"
```

---

### Task 3: `stak memory unlock`

**Files:**
- Modify: `packages/cli/src/commands/memory.ts`
- Modify: `packages/cli/src/program.ts`
- Modify: `docs/commands.md`, `docs/memory.md`
- Test: wherever the `memory` subcommands are tested today

**Interfaces:**
- Consumes: `unlockMemory`, `UnlockResult`, `MemoryLockRecord` from `@stack/memory`.
- Produces, on `MemoryCommandDependencies`: `unlockMemory?(options: { force: boolean }): Promise<UnlockResult>`

- [ ] **Step 1: Write the failing tests**

Test these four outputs, using the existing memory-command test harness:

```ts
// no lock
expect(out).toBe('No Memory lock is held.\n');
// removed (process not running)
expect(out).toBe('Removed the Memory lock held by `stak pull` (process 1234, started 3m ago, no longer running).\n');
// refused
// -> command exits non-zero with:
'The Memory lock is held by `stak pull` (process 1234 on this-host, started 12s ago), which may still be running.\nWait for it to finish. If you are sure it is not a STAK command, run `stak memory unlock --force`.'
// forced while possibly running
expect(out).toBe(
  'Warning: removing a Memory lock that may belong to a running STAK command. If one is running, its Memory changes can be lost.\nRemoved the Memory lock held by `stak pull` (process 1234).\n',
);
// unreadable lock file
expect(out).toBe('Removed an unreadable Memory lock file.\n');
```

For "started ... ago", reuse the same `ago` formatting as `busyMessage`. Export a small `formatLockAge(startedAt: string, now?: Date): string` from `memory-lock.ts` if needed, and use it in both places.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @memstk/cli test -- --run`
Expected: FAIL, because the subcommand does not exist.

- [ ] **Step 3: Implement**

Register the subcommand, following the file's existing `memory.command(...)` style:

```ts
memory
  .command('unlock')
  .description('Remove a leftover Memory lock left behind by a crashed STAK command')
  .option('--force', 'remove the lock even if its process may still be running (can lose Memory changes)')
  .action(async (options: { force?: boolean }) => {
    if (!dependencies.unlockMemory) throw new Error('Memory unlock is not available.');
    const result = await dependencies.unlockMemory({ force: options.force === true });
    // render each UnlockResult status with the exact strings from Step 1;
    // 'refused' throws an Error with the refused message, so the exit code is non-zero
  });
```

Wire `unlockMemory: (options) => unlockMemory(stackHome, options)` in `program.ts`. `stak memory unlock` must NOT itself take the Memory lock.

Docs:
- In `docs/commands.md`, add `stak memory unlock [--force]` in the existing format.
- In `docs/memory.md`, add two plain sentences:
  - Memory commands now run one at a time. If another is running, a command waits up to 10 seconds, then asks you to try again.
  - After a crash, a leftover lock clears itself automatically. `stak memory unlock` is the manual fallback.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @memstk/cli test -- --run && pnpm --filter @memstk/cli exec tsc --noEmit -p .`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/memory.ts packages/cli/src/program.ts docs/commands.md docs/memory.md <touched test files> packages/memory/src/memory-lock.ts
git commit -m "feat(cli): add stak memory unlock"
```

---

### Task 4: Concurrency tests for the real command pairings

**Files:**
- Create: `packages/cli/src/memory/memory-lock-concurrency.test.ts`

**Interfaces:**
- Consumes: the real CLI Memory functions used by the commands, from `canonical-ops.ts`, `cloud-ops.ts` and `program.ts` wiring, together with the InMemory backend fixtures already used in `canonical-ops.test.ts` and `cloud-ops.test.ts`, plus `withMemoryLock` from `@stack/memory`.

**Note on the spec's "separate Node processes":** the InMemory backend can't be shared across processes. So:
- The **lock primitive** gets its genuine multi-process test in Task 1.
- These **pairing tests** run both commands concurrently in one process, each wrapped in the real file-based `withMemoryLock`, exactly as `program.ts` wires it.

The file lock behaves the same inside one process: the second acquire sees a live holder and waits. Each test must also prove the race is real, by showing data loss when the lock is bypassed.

- [ ] **Step 1: Write the tests**

For each pairing, set up a STAK home, a Claude home and a project, using the existing two-machine fixture helpers in `canonical-ops.test.ts`:
1. `add + pull`
2. `add + push`
3. `pull + push`
4. `materialize + pull`

Then:
- Arrange state where the two commands touch overlapping Memory. For add + pull: Cloud has a doc that pull will merge in, while add stages a native edit.
- Start both through `withMemoryLock(stackHome, '<command>', fn)` with `Promise.all`. Force interleaving by injecting a delay hook, or an awaited `setTimeout(0)` yield, at the points where the commands read and write. If the functions have no hook, run the race many times (for example 25 iterations) and assert the invariant holds on every iteration.
- Assert:
  - the lock was never held by both at once (record enter/exit order through the `fn` wrapper);
  - no document is lost: the final canonical main contains both the pulled doc and the staged edit;
  - the final state equals running the two commands sequentially in one order or the other.
- Add a control test, `without the lock, add + pull can lose the pulled document`. It runs the same race without `withMemoryLock` and asserts the loss happens at least once in N iterations. This proves the test can detect the bug. If the loss can't be reproduced deterministically even with injected yields, keep the control test but skip it (`it.skip`) with a comment explaining why, and say so in your report.

- [ ] **Step 2: Run**

Run: `pnpm --filter @memstk/cli test -- --run memory-lock-concurrency`
Expected: the locked pairing tests PASS, and the control test demonstrates the loss.

- [ ] **Step 3: Full suites and typecheck**

Run: `pnpm -w build`, then vitest and tsc for `@stack/memory`, `@stack/core` and `@memstk/cli`.
Expected: all PASS, apart from the known `packages/core/src/trial.test.ts` failure, which predates this work.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/memory/memory-lock-concurrency.test.ts
git commit -m "test(cli): Memory lock serializes add/pull/push/materialize pairings"
```
