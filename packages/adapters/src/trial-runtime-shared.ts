import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { assertPathWithin } from '@stack/shared';
import { trySessionSchema } from '@stack/spec';
import type {
  TryCleanupComponent,
  TryCleanupDiagnostic,
  TrySession,
} from '@stack/spec';

// Agent-agnostic isolation/cleanup primitives shared by every agent's trial
// runtime module (codex-trial.ts, claude-trial.ts, cursor-trial.ts). None of
// these depend on which agent is being isolated — only on the owned-runtime
// safety invariants (marker-last cleanup, bounded retry, path containment).

export const secureDirectory = async (directory: string) => {
  await mkdir(directory, { recursive: true });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
};

// The ownership marker is written atomically (temp + rename) so it can never be
// observed half-written during ready → running → cleaning → cleanup-failed.
export const writeSession = async (directory: string, session: TrySession) => {
  const target = path.join(directory, 'session.json');
  const temporary = path.join(directory, `.session.json.${randomUUID()}.tmp`);
  const body = `${JSON.stringify(trySessionSchema.parse(session), null, 2)}\n`;
  try {
    await writeFile(temporary, body, 'utf8');
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const readSessionMarker = async (
  directory: string,
): Promise<TrySession> =>
  trySessionSchema.parse(
    JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8')),
  );

// Entries permitted to remain in a session root alongside owned children: the
// marker itself, and any leftover atomic-write temp file we created.
export const isOwnedMetadataEntry = (name: string) =>
  name === 'session.json' ||
  (name.startsWith('.session.json.') && name.endsWith('.tmp'));

// Deletion errors that are commonly transient on Windows (a virus scanner,
// indexer, or just-closed handle briefly holding a file) and worth retrying.
export const transientDeleteCodes = new Set([
  'EPERM',
  'EBUSY',
  'ENOTEMPTY',
  'EACCES',
  'EMFILE',
  'ENFILE',
]);

export type RemoveRuntimeEntry = (target: string) => Promise<void>;
export type TryCleanupControls = {
  now?: () => Date;
  removeEntry?: RemoveRuntimeEntry;
  maxRetries?: number;
  retryDelayMs?: number;
  // Bounded grace period before the first delete attempt, giving any just-closed
  // child's short-lived background descendants (e.g. a quick Git refresh) time to
  // release handles on the runtime. Not a substitute for the bounded retries.
  settleDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};
export type TryCleanupOutcome =
  | { cleaned: true }
  | { cleaned: false; diagnostic: TryCleanupDiagnostic; runtimePath: string };

export const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
// Node's `rm` also accepts maxRetries/retryDelay; we run our own bounded loop so
// the identical policy covers injected removers (tests) and the specific
// transient codes above, and never retries forever.
export const defaultRemoveRuntimeEntry: RemoveRuntimeEntry = (target) =>
  rm(target, { recursive: true, force: true });

export const removeWithBoundedRetry = async (
  target: string,
  remove: RemoveRuntimeEntry,
  maxAttempts: number,
  retryDelayMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await remove(target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= maxAttempts || !code || !transientDeleteCodes.has(code))
        throw error;
      await sleep(retryDelayMs);
    }
  }
};

export const removeOwnedRuntimePath = async (
  runtimeRoot: string,
  target: string,
): Promise<void> => {
  await assertPathWithin({ ownedRoot: runtimeRoot, proposedPath: target });
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
};

export const safeCleanupDiagnostic = (
  component: TryCleanupComponent,
  error: unknown,
  now: () => Date,
): TryCleanupDiagnostic => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return {
    component,
    ...(code && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? { code } : {}),
    at: now().toISOString(),
  };
};
