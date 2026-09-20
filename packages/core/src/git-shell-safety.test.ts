import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnCalls: Array<{
  file: string;
  args: string[];
  options: { shell?: boolean };
}> = [];

vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[], options: { shell?: boolean }) => {
    spawnCalls.push({ file, args, options });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // Succeed at every git step; the missing checkout content makes
    // restoreReference abort after all commands have been spawned.
    queueMicrotask(() => child.emit('close', 0));
    return child;
  },
}));

const { restoreReference } = await import('./git-reference.js');
const { ReferenceRestoreFailedError } = await import('@stack/cloud-client');

const roots: string[] = [];
afterEach(async () => {
  spawnCalls.length = 0;
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

describe('git reference restoration shell safety', () => {
  it('spawns git with shell:false and passes the remote as a single argument', async () => {
    const stackHome = await mkdtemp(path.join(tmpdir(), 'stack-shell-'));
    roots.push(stackHome);
    // A remote laden with shell metacharacters must never be interpreted.
    const remote = 'https://example.com/org/repo.git;rm -rf ~';
    await expect(
      restoreReference({
        stackHome,
        reference: {
          remote,
          revision: 'a'.repeat(40),
          path: 'skills/demo',
          expectedContentHash: `sha256:${'0'.repeat(64)}`,
        },
      }),
    ).rejects.toBeInstanceOf(ReferenceRestoreFailedError);

    expect(spawnCalls.length).toBeGreaterThan(0);
    for (const call of spawnCalls) {
      expect(call.file).toBe('git');
      expect(Array.isArray(call.args)).toBe(true);
      expect(call.options.shell).toBe(false);
    }
    // The remote and revision travel as discrete argv entries, never spliced
    // into a shell command string.
    const remoteAdd = spawnCalls.find((call) => call.args.includes('remote'));
    expect(remoteAdd?.args).toEqual(['remote', 'add', 'origin', remote]);
    const fetch = spawnCalls.find((call) => call.args.includes('fetch'));
    expect(fetch?.args).toContain('a'.repeat(40));
  });
});
