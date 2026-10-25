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
