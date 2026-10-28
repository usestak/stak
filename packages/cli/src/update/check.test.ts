import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHECK_INTERVAL_MS,
  distTagsUrl,
  readUpdateCache,
  startUpdateReminder,
  updateReminderMessage,
  type FetchLike,
  type UpdateCheckCache,
  type UpdateReminderDependencies,
} from './check.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-27T12:00:00.000Z');

let home: string;
let cachePath: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'stak-update-check-'));
  cachePath = path.join(home, 'update-check.json');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const registry = (tags: Record<string, string>, status = 200) =>
  vi.fn<FetchLike>(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => tags,
  }));

const setup = (overrides: Partial<UpdateReminderDependencies> = {}) => {
  const errors: string[] = [];
  const fetch = (overrides.fetch ??
    registry({ latest: '0.1.2', beta: '0.2.0-beta.4' })) as ReturnType<
    typeof registry
  >;
  const dependencies: UpdateReminderDependencies = {
    currentVersion: '0.2.0-beta.3',
    cachePath,
    fetch,
    now: () => T0,
    env: {},
    isTTY: true,
    argv: ['node', 'stak', 'status'],
    writeErr: (value) => errors.push(value),
    ...overrides,
  };
  return { dependencies, errors, fetch };
};

const run = async (
  overrides: Partial<UpdateReminderDependencies> = {},
  commandName = 'status',
) => {
  const harness = setup(overrides);
  await startUpdateReminder(harness.dependencies, { commandName }).finish();
  return harness;
};

const seedCache = async (cache: UpdateCheckCache) =>
  writeFile(cachePath, JSON.stringify(cache));

describe('update reminder — when it checks and reuses the cache', () => {
  it('fetches when there is no cache, and writes the result atomically', async () => {
    const { fetch } = await run();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://registry.npmjs.org/-/package/@memstk%2Fcli/dist-tags',
    );
    const cache = await readUpdateCache(cachePath);
    expect(cache).toMatchObject({
      channel: 'beta',
      latest: '0.2.0-beta.4',
      checkedAt: T0,
    });
  });

  it('makes no network call when the cache is fresh', async () => {
    await seedCache({
      channel: 'beta',
      latest: '0.2.0-beta.4',
      checkedAt: T0 - 23 * HOUR,
    });
    const { fetch, errors } = await run();
    expect(fetch).not.toHaveBeenCalled();
    // …but still compares and reminds from the cached answer.
    expect(errors).toHaveLength(1);
  });

  it('refetches when the cache is stale (older than 24 h)', async () => {
    await seedCache({
      channel: 'beta',
      latest: '0.2.0-beta.3',
      checkedAt: T0 - 25 * HOUR,
    });
    const { fetch } = await run();
    expect(fetch).toHaveBeenCalledOnce();
    expect((await readUpdateCache(cachePath))?.latest).toBe('0.2.0-beta.4');
  });

  it('refetches when the cache was written for another channel', async () => {
    await seedCache({
      channel: 'latest',
      latest: '0.1.2',
      checkedAt: T0 - HOUR,
    });
    const { fetch } = await run();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('recovers from a corrupt cache file', async () => {
    await writeFile(cachePath, '{not json');
    const { fetch, errors } = await run();
    expect(fetch).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    expect(JSON.parse(await readFile(cachePath, 'utf8'))).toMatchObject({
      latest: '0.2.0-beta.4',
    });
  });

  it('treats a well-formed but wrong-shaped cache as missing', async () => {
    await writeFile(cachePath, JSON.stringify({ latest: 42 }));
    const { fetch } = await run();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('honours an npm_config_registry override', async () => {
    const { fetch } = await run({
      env: { npm_config_registry: 'https://npm.example.test/registry/' },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://npm.example.test/registry/-/package/@memstk%2Fcli/dist-tags',
    );
    expect(distTagsUrl({})).toBe(
      'https://registry.npmjs.org/-/package/@memstk%2Fcli/dist-tags',
    );
  });

  it('is silent on a network failure and records only the failed attempt', async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      throw new TypeError('fetch failed');
    });
    const { errors } = await run({ fetch });
    expect(errors).toEqual([]);
    expect(await readUpdateCache(cachePath)).toEqual({
      channel: 'beta',
      failedAt: T0,
    });
  });

  it('is silent on a registry 404 or a missing dist-tag', async () => {
    expect((await run({ fetch: registry({}, 404) })).errors).toEqual([]);
    expect((await readUpdateCache(cachePath))?.failedAt).toBe(T0);
    await rm(cachePath, { force: true });
    expect(
      (await run({ fetch: registry({ latest: '9.9.9' }) })).errors,
    ).toEqual([]);
    expect((await readUpdateCache(cachePath))?.failedAt).toBe(T0);
  });

  it('backs off for 1 h after a failure, then retries', async () => {
    const down = registry({}, 404);
    await run({ fetch: down });
    expect(down).toHaveBeenCalledOnce();

    // Within the hour: no network call at all, so no ~1 s wait per command.
    const during = registry({ beta: '0.2.0-beta.4' });
    expect(
      (await run({ fetch: during, now: () => T0 + 59 * 60 * 1000 })).errors,
    ).toEqual([]);
    expect(during).not.toHaveBeenCalled();

    // After the hour: retries, succeeds, clears the failure, and resumes the 24 h cadence.
    const after = registry({ beta: '0.2.0-beta.4' });
    const { errors } = await run({ fetch: after, now: () => T0 + HOUR });
    expect(after).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    const cache = await readUpdateCache(cachePath);
    expect(cache).toMatchObject({
      latest: '0.2.0-beta.4',
      checkedAt: T0 + HOUR,
    });
    expect(cache?.failedAt).toBeUndefined();
    const later = registry({ beta: '0.2.0-beta.5' });
    await run({ fetch: later, now: () => T0 + 23 * HOUR });
    expect(later).not.toHaveBeenCalled();
  });

  it('keeps the last known version during a backoff and still reminds from it', async () => {
    await seedCache({
      channel: 'beta',
      latest: '0.2.0-beta.4',
      checkedAt: T0 - 25 * HOUR,
    });
    const down = vi.fn<FetchLike>(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await run({ fetch: down })).errors).toEqual([]);
    expect(await readUpdateCache(cachePath)).toMatchObject({
      latest: '0.2.0-beta.4',
      failedAt: T0,
    });
    const idle = registry({ beta: '0.2.0-beta.4' });
    const { errors } = await run({
      fetch: idle,
      now: () => T0 + 10 * 60 * 1000,
    });
    expect(idle).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
  });

  it('still reminds (and never throws) when the cache cannot be written', async () => {
    // The cache's parent "directory" is a regular file, so mkdir/rename fail.
    await writeFile(path.join(home, 'blocker'), 'x');
    const { errors } = await run({
      cachePath: path.join(home, 'blocker', 'update-check.json'),
    });
    expect(errors).toHaveLength(1);
  });
});

describe('update reminder — when it prints', () => {
  it('prints the exact one-line reminder for a newer version on the same channel', async () => {
    const { errors } = await run();
    expect(errors).toEqual([
      'STAK 0.2.0-beta.4 is available (you have 0.2.0-beta.3). Update: stak upgrade  (or npm i -g @memstk/cli@beta)\n',
    ]);
  });

  it('uses the latest channel for a release build', async () => {
    const { errors, fetch } = await run({
      currentVersion: '0.1.1',
      fetch: registry({ latest: '0.1.2', beta: '0.2.0-beta.4' }),
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(errors).toEqual([
      updateReminderMessage({
        latest: '0.1.2',
        current: '0.1.1',
        channel: 'latest',
      }),
    ]);
    expect(errors[0]).toContain('npm i -g @memstk/cli@latest');
  });

  it('ignores a newer version on another channel', async () => {
    const { errors } = await run({
      currentVersion: '0.1.2',
      fetch: registry({ latest: '0.1.2', beta: '0.2.0-beta.4' }),
    });
    expect(errors).toEqual([]);
  });

  it('stays quiet when up to date, and never suggests a downgrade', async () => {
    expect(
      (await run({ fetch: registry({ beta: '0.2.0-beta.3' }) })).errors,
    ).toEqual([]);
    await rm(cachePath, { force: true });
    expect(
      (await run({ fetch: registry({ beta: '0.2.0-beta.2' }) })).errors,
    ).toEqual([]);
    await rm(cachePath, { force: true });
    expect(
      (
        await run({
          currentVersion: '0.2.0',
          fetch: registry({ latest: '0.1.2' }),
        })
      ).errors,
    ).toEqual([]);
  });

  it('shows a given version at most once per day', async () => {
    expect((await run()).errors).toHaveLength(1);
    expect((await run({ now: () => T0 + HOUR })).errors).toEqual([]);
    expect((await run({ now: () => T0 + 23 * HOUR })).errors).toEqual([]);
    expect(
      (await run({ now: () => T0 + CHECK_INTERVAL_MS + HOUR })).errors,
    ).toHaveLength(1);
  });

  it('announces a newer version the same day even after reminding about an older one', async () => {
    expect((await run()).errors).toHaveLength(1);
    // A day-old check refetches and finds yet another release.
    const announced = await readUpdateCache(cachePath);
    expect(announced?.notifiedVersion).toBe('0.2.0-beta.4');
    await seedCache({
      channel: 'beta',
      latest: '0.2.0-beta.4',
      notifiedVersion: '0.2.0-beta.4',
      notifiedAt: T0,
      checkedAt: T0 - 25 * HOUR,
    });
    const { errors } = await run({
      now: () => T0 + HOUR,
      fetch: registry({ beta: '0.2.0-beta.5' }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('0.2.0-beta.5');
  });

  const suppressed: Array<
    [string, Partial<UpdateReminderDependencies>, string?]
  > = [
    ['stderr is not a TTY', { isTTY: false }],
    ['CI is set', { env: { CI: 'true' } }],
    ['CI=1', { env: { CI: '1' } }],
    ['--json is present', { argv: ['node', 'stak', 'status', '--json'] }],
    ['STAK_NO_UPDATE_CHECK=1', { env: { STAK_NO_UPDATE_CHECK: '1' } }],
    ['NO_UPDATE_NOTIFIER is set', { env: { NO_UPDATE_NOTIFIER: '1' } }],
    ['--version', { argv: ['node', 'stak', '--version'] }],
    ['-V', { argv: ['node', 'stak', '-V'] }],
    ['--help', { argv: ['node', 'stak', 'status', '--help'] }],
    ['-h', { argv: ['node', 'stak', '-h'] }],
    [
      'the command is stak upgrade',
      { argv: ['node', 'stak', 'upgrade'] },
      'upgrade',
    ],
  ];

  for (const [label, overrides, commandName] of suppressed)
    it(`stays quiet and makes no network call when ${label}`, async () => {
      const { errors, fetch } = await run(overrides, commandName);
      expect(errors).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });

  it('does not delay a finished command beyond the ~1 s cap when the registry is slow, and still backs off', async () => {
    let aborted = false;
    const slow = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve({
                ok: true,
                status: 200,
                json: async () => ({ beta: '0.2.0-beta.4' }),
              }),
            3_000,
          );
          init.signal.addEventListener('abort', () => {
            aborted = true;
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        }),
    );
    const { dependencies, errors } = setup({ fetch: slow });
    const handle = startUpdateReminder(dependencies, { commandName: 'status' });
    const started = Date.now();
    await handle.finish();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(1_500);
    expect(errors).toEqual([]);
    expect(aborted).toBe(true);
    // The command's own ~1 s wait is over, but the background lookup is still settling
    // (aborting the fetch, then writing the backoff) — give it a moment to land.
    await vi.waitFor(async () => {
      expect(await readUpdateCache(cachePath)).toMatchObject({
        channel: 'beta',
        failedAt: T0,
      });
    });
  });

  it('a hanging registry (past the hard ceiling) backs off for 1 h, so the next command makes no network call', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init.signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        init.signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      });
    const hang = vi.fn(hanging);
    const { errors } = await run({
      fetch: hang,
      fetchTimeoutMs: 20,
      waitCapMs: 1_000,
    });
    expect(errors).toEqual([]);
    expect(await readUpdateCache(cachePath)).toEqual({
      channel: 'beta',
      failedAt: T0,
    });

    // Within the hour: no network call at all, so no ~1 s wait per command.
    const during = registry({ beta: '0.2.0-beta.4' });
    expect(
      (await run({ fetch: during, now: () => T0 + 30 * 60 * 1000 })).errors,
    ).toEqual([]);
    expect(during).not.toHaveBeenCalled();
  });

  it('cancel() (a failed command) does not record a registry failure', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init.signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        init.signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      });
    const hang = vi.fn(hanging);
    const { dependencies, errors } = setup({
      fetch: hang,
      waitCapMs: 50,
      fetchTimeoutMs: 50,
    });
    const handle = startUpdateReminder(dependencies, { commandName: 'status' });
    handle.cancel();
    await handle.finish();
    expect(errors).toEqual([]);
    // Give the aborted lookup's background promise a moment to settle, then confirm
    // no backoff was recorded for a cancellation that isn't a registry failure.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await readUpdateCache(cachePath)).toBeUndefined();
  });

  it('a lookup that already finished during the command costs no extra wait', async () => {
    const { dependencies, errors } = setup();
    const handle = startUpdateReminder(dependencies, { commandName: 'status' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await handle.finish();
    expect(Date.now() - started).toBeLessThan(200);
    expect(errors).toHaveLength(1);
  });

  it('cancel() abandons the lookup without printing', async () => {
    // Like the real fetch, reject once aborted. A mock that ignores the signal lets the
    // abandoned lookup go on to write the cache into `home` while afterEach removes it
    // (ENOTEMPTY on Linux CI).
    const abortable = vi.fn<FetchLike>(async (_url, init) => {
      if (init.signal.aborted) throw new Error('aborted');
      return {
        ok: true,
        status: 200,
        json: async () => ({ beta: '0.2.0-beta.4' }),
      };
    });
    const { dependencies, errors } = setup({ fetch: abortable });
    const handle = startUpdateReminder(dependencies, { commandName: 'status' });
    handle.cancel();
    await handle.finish();
    expect(errors).toEqual([]);
  });
});
