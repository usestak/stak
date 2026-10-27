import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { channelFor, isNewerVersion, type ReleaseChannel } from './version.js';

/**
 * The update reminder (approved design, 0.2.0-beta.3). At most once per 24 h it looks up the
 * newest version on the installed build's npm dist-tag, caches the answer under STAK_HOME, and
 * — after the command's own output — prints one stderr line when a newer version exists. It
 * must never slow down or break a command: the lookup starts with the command, is waited on
 * for at most ~1 s afterwards, and every failure (network, registry 404, bad cache) is silent.
 */

export const PACKAGE_NAME = '@memstk/cli';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const UPDATE_CHECK_FILE = 'update-check.json';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After a failed lookup (network error, 404, no dist-tag), wait this long before retrying. */
export const FAILURE_BACKOFF_MS = 60 * 60 * 1000;
/** How long a finished command waits for an in-flight lookup before giving up silently. */
export const DEFAULT_WAIT_CAP_MS = 1_000;
/** Hard ceiling on the background lookup, so a hung registry never holds the process open. */
export const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type Env = Readonly<Record<string, string | undefined>>;

export type UpdateCheckCache = {
  channel: ReleaseChannel;
  /** Newest version on `channel` at the last successful check (absent if none succeeded). */
  latest?: string;
  /** Epoch ms of the last successful registry check. */
  checkedAt?: number;
  /** Epoch ms of the last failed lookup; starts a 1 h backoff. Cleared by a success. */
  failedAt?: number;
  /** The version last announced, and when — so a version is announced at most once a day. */
  notifiedVersion?: string;
  notifiedAt?: number;
};

const truthyFlag = (value: string | undefined): boolean =>
  value !== undefined &&
  value.trim() !== '' &&
  !/^(?:0|false|no)$/i.test(value.trim());

/** `npm_config_registry` (as npm exports it to child processes) overrides the public registry. */
export const registryBaseUrl = (env: Env): string => {
  const override = (env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY)?.trim();
  return (override || DEFAULT_REGISTRY).replace(/\/+$/, '');
};

export const distTagsUrl = (env: Env): string =>
  `${registryBaseUrl(env)}/-/package/${PACKAGE_NAME.replace('/', '%2F')}/dist-tags`;

/** The newest version published on `channel`. Throws on any failure; callers decide whether to care. */
export const fetchLatestVersion = async (options: {
  fetch: FetchLike;
  env: Env;
  channel: ReleaseChannel;
  signal: AbortSignal;
}): Promise<string> => {
  const response = await options.fetch(distTagsUrl(options.env), {
    signal: options.signal,
    headers: { accept: 'application/json' },
  });
  if (!response.ok)
    throw new Error(`Registry responded with HTTP ${response.status}.`);
  const tags = (await response.json()) as Record<string, unknown> | null;
  const version = tags?.[options.channel];
  if (typeof version !== 'string' || version.trim() === '')
    throw new Error(`No "${options.channel}" dist-tag was published.`);
  return version.trim();
};

const isCache = (value: unknown): value is UpdateCheckCache => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.channel === 'latest' || record.channel === 'beta') &&
    (record.latest === undefined || typeof record.latest === 'string') &&
    (record.checkedAt === undefined ||
      (typeof record.checkedAt === 'number' &&
        Number.isFinite(record.checkedAt))) &&
    (record.failedAt === undefined ||
      (typeof record.failedAt === 'number' &&
        Number.isFinite(record.failedAt))) &&
    (record.notifiedVersion === undefined ||
      typeof record.notifiedVersion === 'string') &&
    (record.notifiedAt === undefined || typeof record.notifiedAt === 'number')
  );
};

/** A missing, unreadable, or malformed cache file reads as "no cache" — never an error. */
export const readUpdateCache = async (
  cachePath: string,
): Promise<UpdateCheckCache | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(cachePath, 'utf8'));
    return isCache(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Atomic write: a temp sibling is written, then renamed over the target. */
export const writeUpdateCache = async (
  cachePath: string,
  cache: UpdateCheckCache,
): Promise<void> => {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const temporary = path.join(
    path.dirname(cachePath),
    `.${path.basename(cachePath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, cachePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

/**
 * Whether the reminder must stay quiet for this invocation: non-TTY stderr, CI, `--json`,
 * an opt-out env var, or `stak upgrade` / `--version` / `--help` themselves.
 */
export const isUpdateCheckSuppressed = (context: {
  env: Env;
  isTTY: boolean;
  argv: readonly string[];
  commandName?: string;
}): boolean => {
  const { env, argv } = context;
  if (!context.isTTY) return true;
  if (truthyFlag(env.CI)) return true;
  if (truthyFlag(env.STAK_NO_UPDATE_CHECK)) return true;
  if (truthyFlag(env.NO_UPDATE_NOTIFIER)) return true;
  if (context.commandName === 'upgrade') return true;
  return argv.some(
    (argument) =>
      argument === '--json' ||
      argument.startsWith('--json=') ||
      argument === '--version' ||
      argument === '-V' ||
      argument === '--help' ||
      argument === '-h',
  );
};

export const updateReminderMessage = (options: {
  latest: string;
  current: string;
  channel: ReleaseChannel;
}): string =>
  `STAK ${options.latest} is available (you have ${options.current}). ` +
  `Update: stak upgrade  (or npm i -g ${PACKAGE_NAME}@${options.channel})\n`;

export type UpdateReminderDependencies = {
  currentVersion: string;
  /** Absolute path of the cache file, normally `<STAK_HOME>/update-check.json`. */
  cachePath: string;
  fetch: FetchLike;
  now(): number;
  env: Env;
  /** Whether stderr is a TTY. */
  isTTY: boolean;
  argv: readonly string[];
  writeErr(value: string): void;
  waitCapMs?: number;
  fetchTimeoutMs?: number;
};

export type UpdateReminderHandle = {
  /** Wait (≤ the cap) for the lookup, then print the reminder if one is due. Never throws. */
  finish(): Promise<void>;
  /** Abandon the lookup without printing (e.g. the command failed). */
  cancel(): void;
};

const QUIET: UpdateReminderHandle = {
  finish: async () => undefined,
  cancel: () => undefined,
};

/**
 * Start the lookup without awaiting it. Call at the beginning of a command; call
 * `finish()` once the command's own output is done.
 */
export const startUpdateReminder = (
  dependencies: UpdateReminderDependencies,
  context: { commandName?: string } = {},
): UpdateReminderHandle => {
  try {
    if (
      isUpdateCheckSuppressed({
        env: dependencies.env,
        isTTY: dependencies.isTTY,
        argv: dependencies.argv,
        ...(context.commandName ? { commandName: context.commandName } : {}),
      })
    )
      return QUIET;
  } catch {
    return QUIET;
  }

  const current = dependencies.currentVersion;
  const channel = channelFor(current);
  const controller = new AbortController();
  const ceiling = setTimeout(
    () => controller.abort(),
    dependencies.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );
  ceiling.unref?.();

  const lookup: Promise<UpdateCheckCache | undefined> = (async () => {
    const loaded = await readUpdateCache(dependencies.cachePath);
    const cached = loaded?.channel === channel ? loaded : undefined;
    const now = dependencies.now();
    const within = (at: number | undefined, interval: number): boolean =>
      at !== undefined && now - at >= 0 && now - at < interval;
    // A successful check is reused for 24 h; a failed one backs off for 1 h, so commands
    // don't each pay the ~1 s wait while the registry is down. Either way: no network call.
    if (
      cached &&
      ((cached.latest !== undefined &&
        within(cached.checkedAt, CHECK_INTERVAL_MS)) ||
        within(cached.failedAt, FAILURE_BACKOFF_MS))
    )
      return cached;
    let latest: string;
    try {
      latest = await fetchLatestVersion({
        fetch: dependencies.fetch,
        env: dependencies.env,
        channel,
        signal: controller.signal,
      });
    } catch (error) {
      // Our own abort (the wait cap, the hard ceiling, or a failed command) is not a
      // registry failure: just try again next time.
      if (!controller.signal.aborted)
        await writeUpdateCache(dependencies.cachePath, {
          ...(cached ?? { channel }),
          failedAt: now,
        }).catch(() => undefined);
      throw error;
    }
    const next: UpdateCheckCache = {
      channel,
      latest,
      checkedAt: dependencies.now(),
      ...(cached?.notifiedVersion !== undefined
        ? { notifiedVersion: cached.notifiedVersion }
        : {}),
      ...(cached?.notifiedAt !== undefined
        ? { notifiedAt: cached.notifiedAt }
        : {}),
    };
    await writeUpdateCache(dependencies.cachePath, next).catch(() => undefined);
    return next;
  })()
    .catch(() => undefined)
    .finally(() => clearTimeout(ceiling));

  let done = false;
  const cancel = (): void => {
    done = true;
    clearTimeout(ceiling);
    controller.abort();
  };

  return {
    cancel,
    finish: async () => {
      if (done) return;
      done = true;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = Symbol('timed-out');
        const result = await Promise.race([
          lookup,
          new Promise<typeof timedOut>((resolve) => {
            timer = setTimeout(
              () => resolve(timedOut),
              dependencies.waitCapMs ?? DEFAULT_WAIT_CAP_MS,
            );
          }),
        ]);
        clearTimeout(timer);
        if (result === timedOut) {
          // Give up silently; the next command tries again.
          controller.abort();
          return;
        }
        if (!result?.latest || !isNewerVersion(result.latest, current)) return;
        const now = dependencies.now();
        if (
          result.notifiedVersion === result.latest &&
          result.notifiedAt !== undefined &&
          now - result.notifiedAt >= 0 &&
          now - result.notifiedAt < CHECK_INTERVAL_MS
        )
          return;
        dependencies.writeErr(
          updateReminderMessage({ latest: result.latest, current, channel }),
        );
        await writeUpdateCache(dependencies.cachePath, {
          ...result,
          notifiedVersion: result.latest,
          notifiedAt: now,
        }).catch(() => undefined);
      } catch {
        // Never let the reminder affect the command.
      }
    },
  };
};
