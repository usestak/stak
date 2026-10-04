/**
 * CLI operations for remote STAK Memory (Phase 14B). Encodes the product rules:
 *  - `backup` ALWAYS makes the safe local Phase 14A backup first, then a Cloud
 *    backup when authenticated (Standard by default, Protected when the account is
 *    Protected AND this device holds the MMK). If the account is Protected but the
 *    MMK is unavailable, the Cloud portion FAILS CLOSED — never a silent Standard
 *    fallback. Cloud failure never invalidates the local backup.
 *  - `recover` rebuilds the local private store from Cloud (Protected needs the MMK,
 *    from this device or a recovery method). It never writes native agent files.
 *  - `protect` establishes the MMK + a recovery method, enrolls this device, and
 *    migrates existing Standard backups (verify-before-delete).
 *
 * Pure and injectable (backend, local key store, local-backup runner) so it is
 * fully testable without the network. The commands layer builds the real backend
 * from the authenticated cloud client.
 */
import {
  CIPHER_VERSION,
  addRecoveryFileWrapper,
  asBridgeFailure,
  cloudRecover,
  createRecoverySession,
  LocalKeyStoreError,
  generateMmk,
  migrateStandardToProtected,
  newKeyring,
  openMmkFromEnvelope,
  protectedCloudBackup,
  standardCloudBackup,
  unwrapWithRecoveryKey,
  isHistoricalRecovery,
  readLocalRecoveryState,
  writeLocalRecoveryState,
  type BackupResult,
  type BridgeEnvelope,
  type BridgeFailureReason,
  type LocalMemoryKeyStore,
  type MmkKeyring,
  type MmkWrapper,
  type RecoveryKeyArtifacts,
  type RemoteMemoryBackend,
} from '@stack/memory';

/**
 * How a passkey ceremony can end short of success (Phase R6). `timed-out` and
 * `session-expired` come from the CLI's bounded poll; the others are relayed by the
 * browser through the one-time envelope channel. None ever yields an MMK.
 */
export type PasskeyFailureReason =
  BridgeFailureReason | 'timed-out' | 'session-expired';

export type MemoryCloudDeps = {
  stackHome: string;
  /** Authenticated per-user backend, or null when the user is not signed in. */
  backend: RemoteMemoryBackend | null;
  localKeyStore: LocalMemoryKeyStore;
  runLocalBackup: () => Promise<BackupResult>;
  now?: () => Date;
};

export type CloudBackupOutcome =
  | { status: 'skipped' }
  | { status: 'protected-locked' }
  | { status: 'failed'; message: string }
  | { status: 'standard'; generation: number }
  | { status: 'protected'; generation: number };

export type MemoryBackupOutcome = {
  local: BackupResult;
  cloud: CloudBackupOutcome;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown error.';

const isInsecureLocalKey = (error: unknown): boolean =>
  error instanceof LocalKeyStoreError && error.code === 'insecure-permissions';

/**
 * Enroll this device with the MMK, tolerating a fail-closed permission error: on
 * insecure local storage nothing is persisted (saveMmk cleaned up) and we report
 * not-enrolled rather than aborting a recovery that already succeeded. Other errors
 * propagate.
 */
const enrollDeviceSafe = async (
  localKeyStore: LocalMemoryKeyStore,
  mmk: Buffer,
): Promise<boolean> => {
  try {
    await localKeyStore.saveMmk(mmk);
    return true;
  } catch (error) {
    if (isInsecureLocalKey(error)) return false;
    throw error;
  }
};

/** How the MMK wrapper is stored inside a cloud recovery method (opaque to server). */
type StoredWrapper = { mmkId: string; wrapper: MmkWrapper };

const isStoredWrapper = (value: unknown): value is StoredWrapper =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { mmkId?: unknown }).mmkId === 'string' &&
  typeof (value as { wrapper?: unknown }).wrapper === 'object';

/**
 * Record which Cloud generation the local private store now reflects (Phase 15B.6).
 * Machine-local, non-secret provenance so `status` can flag a historical recovery and
 * a later backup can warn before superseding a newer Cloud generation.
 */
const recordRecoveryProvenance = async (
  deps: MemoryCloudDeps,
  recovered: {
    generation: number;
    privacyMode: 'standard' | 'protected';
    cloudLatest: number | null;
  },
): Promise<void> => {
  await writeLocalRecoveryState(deps.stackHome, {
    schemaVersion: 1,
    recoveredGeneration: recovered.generation,
    cloudLatestAtRecovery: recovered.cloudLatest,
    recoveredAt: (deps.now ?? (() => new Date()))().toISOString(),
    privacyMode: recovered.privacyMode,
  });
};

/** backup: local first, then Cloud (never fails the local commit). */
export const runMemoryCloudBackup = async (
  deps: MemoryCloudDeps,
): Promise<MemoryBackupOutcome> => {
  const local = await deps.runLocalBackup();
  if (!deps.backend) return { local, cloud: { status: 'skipped' } };
  try {
    const profile = await deps.backend.getProfile();
    const mode = profile?.privacyMode ?? 'standard';
    if (mode === 'protected') {
      const mmk = await deps.localKeyStore.loadMmk();
      if (!mmk) return { local, cloud: { status: 'protected-locked' } };
      const result = await protectedCloudBackup({
        stackHome: deps.stackHome,
        backend: deps.backend,
        mmk,
        ...(deps.now ? { now: deps.now } : {}),
      });
      // Local state now equals the new latest generation — clear any historical
      // provenance so status returns to normal.
      await recordRecoveryProvenance(deps, {
        generation: result.generation,
        privacyMode: 'protected',
        cloudLatest: result.generation,
      });
      return {
        local,
        cloud: { status: 'protected', generation: result.generation },
      };
    }
    const result = await standardCloudBackup({
      stackHome: deps.stackHome,
      backend: deps.backend,
      ...(deps.now ? { now: deps.now } : {}),
    });
    await recordRecoveryProvenance(deps, {
      generation: result.generation,
      privacyMode: 'standard',
      cloudLatest: result.generation,
    });
    return {
      local,
      cloud: { status: 'standard', generation: result.generation },
    };
  } catch (error) {
    return { local, cloud: { status: 'failed', message: errorMessage(error) } };
  }
};

export type CloudRecoverOutcome =
  | {
      status: 'recovered';
      privacyMode: 'standard' | 'protected';
      objects: number;
      generation: number;
    }
  | { status: 'needs-recovery-method' }
  | { status: 'not-authenticated' }
  | { status: 'no-backup' };

/** Recover the private store from Cloud. Does not touch native agent files. */
export const runMemoryCloudRecover = async (
  deps: MemoryCloudDeps,
  options: { generation?: number; recoveryKey?: Buffer } = {},
): Promise<CloudRecoverOutcome> => {
  if (!deps.backend) return { status: 'not-authenticated' };
  const meta =
    options.generation !== undefined
      ? await deps.backend.getGeneration(options.generation)
      : await deps.backend.getLatest();
  if (!meta) return { status: 'no-backup' };

  const cloudLatest = (await deps.backend.getLatest())?.generation ?? null;

  if (meta.privacyMode === 'standard') {
    const result = await cloudRecover({
      stackHome: deps.stackHome,
      backend: deps.backend,
      ...(options.generation !== undefined
        ? { generation: options.generation }
        : {}),
    });
    await recordRecoveryProvenance(deps, {
      generation: result.generation,
      privacyMode: 'standard',
      cloudLatest,
    });
    return {
      status: 'recovered',
      privacyMode: 'standard',
      objects: result.objects,
      generation: result.generation,
    };
  }

  // Protected: obtain the MMK from this device or an offered recovery key.
  let mmk = await deps.localKeyStore.loadMmk();
  let unlockedViaRecoveryKey = false;
  if (!mmk && options.recoveryKey) {
    mmk = await unlockMmkWithRecoveryKey(deps.backend, options.recoveryKey);
    unlockedViaRecoveryKey = mmk !== null;
  }
  if (!mmk) return { status: 'needs-recovery-method' };

  const result = await cloudRecover({
    stackHome: deps.stackHome,
    backend: deps.backend,
    mmk,
    ...(options.generation !== undefined
      ? { generation: options.generation }
      : {}),
  });
  // Recovery already succeeded; enrolling this device is best-effort and must not
  // persist insecure key material (enrollDeviceSafe fails closed internally).
  if (unlockedViaRecoveryKey) await enrollDeviceSafe(deps.localKeyStore, mmk);
  await recordRecoveryProvenance(deps, {
    generation: result.generation,
    privacyMode: 'protected',
    cloudLatest,
  });
  return {
    status: 'recovered',
    privacyMode: 'protected',
    objects: result.objects,
    generation: result.generation,
  };
};

/** Try each stored recovery-file wrapper until the recovery key unwraps the MMK. */
const unlockMmkWithRecoveryKey = async (
  backend: RemoteMemoryBackend,
  recoveryKey: Buffer,
): Promise<Buffer | null> => {
  const methods = await backend.listRecoveryMethods();
  for (const method of methods) {
    if (method.type !== 'recovery-file') continue;
    if (!isStoredWrapper(method.mmkWrapper)) continue;
    const keyring: MmkKeyring = {
      mmkId: method.mmkWrapper.mmkId,
      wrappers: [method.mmkWrapper.wrapper],
    };
    try {
      return unwrapWithRecoveryKey({
        keyring,
        wrapper: method.mmkWrapper.wrapper,
        recoveryKey,
      });
    } catch {
      // wrong key for this wrapper — try the next
    }
  }
  return null;
};

export type ProtectOutcome =
  | { status: 'protected'; migrated: number; recoveryMethod: 'recovery-file' }
  | { status: 'insecure-local-key' };

/** Enable Protected: new MMK + recovery-file method + device enrollment + migrate. */
export const runMemoryCloudProtect = async (
  deps: MemoryCloudDeps & { backend: RemoteMemoryBackend },
  options: { recoveryKey: RecoveryKeyArtifacts },
): Promise<ProtectOutcome> => {
  const mmk = generateMmk();
  // Enroll this device FIRST and fail closed: if local key storage can't be
  // secured, persist nothing and finalize nothing in Cloud.
  if (!(await enrollDeviceSafe(deps.localKeyStore, mmk)))
    return { status: 'insecure-local-key' };
  const keyring = newKeyring();
  const { wrapper } = addRecoveryFileWrapper({
    keyring,
    mmk,
    recoveryKey: options.recoveryKey.keyBytes,
  });
  const stored: StoredWrapper = { mmkId: keyring.mmkId, wrapper };
  await deps.backend.addRecoveryMethod({
    type: 'recovery-file',
    label: 'Recovery file',
    mmkWrapper: stored,
    cryptoVersion: CIPHER_VERSION,
  });
  const migration = await migrateStandardToProtected({
    backend: deps.backend,
    mmk,
    ...(deps.now ? { now: deps.now } : {}),
  });
  return {
    status: 'protected',
    migrated: migration.migrated,
    recoveryMethod: 'recovery-file',
  };
};

export type MemoryCloudStatus = {
  authenticated: boolean;
  privacyMode: 'standard' | 'protected' | null;
  latestGeneration: number | null;
  lastCloudBackupAt: string | null;
  recoveryMethodTypes: string[];
  deviceEnrolled: boolean;
  /** Machine-local: which generation the local store was recovered from (Phase 15B.6). */
  localRecoveredGeneration: number | null;
  /** True when local state came from an OLDER generation than the Cloud latest. */
  historicalRecovery: boolean;
};

export const readMemoryCloudStatus = async (
  deps: MemoryCloudDeps,
): Promise<MemoryCloudStatus> => {
  const deviceEnrolled = await deps.localKeyStore.hasKey();
  const provenance = await readLocalRecoveryState(deps.stackHome);
  const localRecoveredGeneration = provenance?.recoveredGeneration ?? null;
  if (!deps.backend)
    return {
      authenticated: false,
      privacyMode: null,
      latestGeneration: null,
      lastCloudBackupAt: null,
      recoveryMethodTypes: [],
      deviceEnrolled,
      localRecoveredGeneration,
      historicalRecovery: false,
    };
  const profile = await deps.backend.getProfile();
  const latest = await deps.backend.getLatest();
  const methods = await deps.backend.listRecoveryMethods();
  const latestGeneration = profile?.latestGeneration ?? null;
  return {
    authenticated: true,
    privacyMode: profile?.privacyMode ?? null,
    latestGeneration,
    lastCloudBackupAt: latest?.createdAt ?? null,
    recoveryMethodTypes: [...new Set(methods.map((method) => method.type))],
    deviceEnrolled,
    localRecoveredGeneration,
    historicalRecovery: isHistoricalRecovery(provenance, latestGeneration),
  };
};

/* -------------------------------------------------------------------------- */
/* Generation history + historical-base backup context (Phase 15B.6)          */
/* -------------------------------------------------------------------------- */

export type MemoryGenerationSummary = {
  generation: number;
  createdAt: string;
  privacyMode: 'standard' | 'protected';
  state: string;
  payloadBytes: number;
  latest: boolean;
};

export type MemoryGenerationsOutcome =
  | { status: 'not-authenticated' }
  | { status: 'ok'; generations: MemoryGenerationSummary[] };

/**
 * List the user's recoverable (committed) Memory generations, newest first. Exposes
 * only non-secret metadata — never backup UUIDs, payload locators, wrapped DEKs,
 * hashes, or contents.
 */
export const runMemoryGenerations = async (
  deps: MemoryCloudDeps,
): Promise<MemoryGenerationsOutcome> => {
  if (!deps.backend) return { status: 'not-authenticated' };
  const generations = await deps.backend.listGenerations();
  const latest = generations.reduce<number | null>(
    (max, g) => (max === null || g.generation > max ? g.generation : max),
    null,
  );
  return {
    status: 'ok',
    generations: generations.map((g) => ({
      generation: g.generation,
      createdAt: g.createdAt,
      privacyMode: g.privacyMode,
      state: g.state,
      payloadBytes: g.payloadBytes,
      latest: g.generation === latest,
    })),
  };
};

export type BackupSupersession = {
  localRecoveredGeneration: number | null;
  cloudLatestGeneration: number | null;
  parentGeneration: number | null;
  nextGeneration: number | null;
  supersedes: boolean;
};

/**
 * Read-only context for a backup: the local store's recovery provenance and the Cloud
 * latest. A new backup always parents from the Cloud latest (linear history); when the
 * local store came from an OLDER generation, the backup would supersede a newer Cloud
 * generation and must be explicitly confirmed.
 */
export const readBackupSupersession = async (
  deps: MemoryCloudDeps,
): Promise<BackupSupersession> => {
  const provenance = await readLocalRecoveryState(deps.stackHome);
  const localRecoveredGeneration = provenance?.recoveredGeneration ?? null;
  if (!deps.backend)
    return {
      localRecoveredGeneration,
      cloudLatestGeneration: null,
      parentGeneration: null,
      nextGeneration: null,
      supersedes: false,
    };
  const cloudLatestGeneration =
    (await deps.backend.getLatest())?.generation ?? null;
  return {
    localRecoveredGeneration,
    cloudLatestGeneration,
    parentGeneration: cloudLatestGeneration,
    nextGeneration:
      cloudLatestGeneration === null ? 0 : cloudLatestGeneration + 1,
    supersedes: isHistoricalRecovery(provenance, cloudLatestGeneration),
  };
};

/* -------------------------------------------------------------------------- */
/* Passkey flows via the CLI↔browser bridge (server relays opaque only)        */
/* -------------------------------------------------------------------------- */

export type BrowserOpener = (url: string) => Promise<void> | void;

export type PasskeyBridgeDeps = {
  stackHome: string;
  backend: RemoteMemoryBackend | null;
  localKeyStore: LocalMemoryKeyStore;
  webBaseUrl: string;
  openBrowser: BrowserOpener;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  ttlMs?: number;
  timeoutMs?: number;
  pollMs?: number;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const errorCode = (error: unknown): string =>
  error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';

/**
 * The bounded result of waiting for the browser (Phase R6): either the relayed opaque
 * envelope (which may be a success envelope OR a browser failure signal), or a terminal
 * reason that ended the wait without any browser response. The wait is ALWAYS bounded —
 * it never loops past the session deadline — so the CLI can never appear to hang.
 */
type PollOutcome =
  | { ok: true; envelope: unknown }
  | { ok: false; reason: 'timed-out' | 'session-expired' };

/**
 * Poll the one-time relay for the browser's opaque envelope. The relay reports
 * `no-envelope` until the browser submits (success envelope or failure signal),
 * `session-expired` once the session's lifetime passes, and marks the session consumed
 * on the first successful read. Bounded by `timeoutMs` (the session lifetime).
 */
const pollForEnvelope = async (
  backend: RemoteMemoryBackend,
  sessionId: string,
  options: {
    sleep: (ms: number) => Promise<void>;
    now: () => Date;
    timeoutMs: number;
    pollMs: number;
  },
): Promise<PollOutcome> => {
  const deadline = options.now().getTime() + options.timeoutMs;
  for (;;) {
    try {
      const { envelope } = await backend.consumeRecoverySession(
        sessionId,
        options.now,
      );
      return { ok: true, envelope };
    } catch (error) {
      const code = errorCode(error);
      if (code.endsWith('no-envelope')) {
        if (options.now().getTime() > deadline)
          return { ok: false, reason: 'timed-out' };
        await options.sleep(options.pollMs);
        continue;
      }
      if (code.endsWith('session-expired'))
        return { ok: false, reason: 'session-expired' };
      throw error;
    }
  }
};

export type PasskeyProtectResult =
  | { status: 'not-authenticated' }
  | { status: 'insecure-local-key' }
  | { status: 'passkey-failed'; reason: PasskeyFailureReason }
  | { status: 'protected'; migrated: number };

/**
 * Enable Protected via a passkey: create a one-time enrollment session, open the
 * browser (which creates the passkey, generates the MMK, stores its passkey wrapper,
 * and seals the MMK back), receive the MMK over the bridge, enroll this device, and
 * migrate existing Standard backups.
 */
export const runPasskeyProtect = async (
  deps: PasskeyBridgeDeps,
): Promise<PasskeyProtectResult> => {
  if (!deps.backend) return { status: 'not-authenticated' };
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const { session, initiatorPrivateKey } = await createRecoverySession({
    userId: 'stack-memory',
    ttlMs: deps.ttlMs ?? 5 * 60_000,
    direction: 'enrollment',
    now,
  });
  await deps.backend.createRecoverySession(
    {
      sessionId: session.sessionId,
      direction: 'enrollment',
      session,
      expiresAt: session.expiresAt,
    },
    now,
  );
  await deps.openBrowser(
    `${deps.webBaseUrl}/memory/protect?session=${encodeURIComponent(session.sessionId)}`,
  );
  const poll = await pollForEnvelope(deps.backend, session.sessionId, {
    sleep,
    now,
    timeoutMs: deps.timeoutMs ?? 5 * 60_000,
    pollMs: deps.pollMs ?? 1500,
  });
  // Terminal, MMK-free failures: a bounded timeout/expiry, or a browser failure signal.
  // Return before any key material is derived — no wrapper, no enrollment, no migration.
  if (!poll.ok) return { status: 'passkey-failed', reason: poll.reason };
  const failure = asBridgeFailure(poll.envelope);
  if (failure) return { status: 'passkey-failed', reason: failure };
  const mmk = await openMmkFromEnvelope({
    session,
    initiatorPrivateKey,
    envelope: poll.envelope as BridgeEnvelope,
    now,
  });
  // Fail closed: do not finalize Protected if this device's key store can't be secured.
  if (!(await enrollDeviceSafe(deps.localKeyStore, mmk)))
    return { status: 'insecure-local-key' };
  const migration = await migrateStandardToProtected({
    backend: deps.backend,
    mmk,
    now,
  });
  return { status: 'protected', migrated: migration.migrated };
};

export type PasskeyRecoverResult =
  | { status: 'not-authenticated' }
  | { status: 'no-backup' }
  | { status: 'passkey-failed'; reason: PasskeyFailureReason }
  | { status: 'recovered'; objects: number; generation: number };

/**
 * Recover Protected Memory via a passkey: create a one-time recovery session, open
 * the browser (which authenticates the passkey, unwraps the MMK via PRF, and seals
 * it back), receive the MMK, enroll this device, and rebuild the local store.
 */
export const runPasskeyRecover = async (
  deps: PasskeyBridgeDeps,
  options: { generation?: number } = {},
): Promise<PasskeyRecoverResult> => {
  if (!deps.backend) return { status: 'not-authenticated' };
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  // The CLI authoritatively selects the generation and fetches/decrypts its payload;
  // the browser only unwraps the (generation-independent) MMK, so there is no
  // browser/server generation TOCTOU. Confirm the requested generation exists first.
  const cloudLatest = (await deps.backend.getLatest())?.generation ?? null;
  const selected =
    options.generation !== undefined
      ? await deps.backend.getGeneration(options.generation)
      : await deps.backend.getLatest();
  if (!selected) return { status: 'no-backup' };
  const { session, initiatorPrivateKey } = await createRecoverySession({
    userId: 'stack-memory',
    ttlMs: deps.ttlMs ?? 5 * 60_000,
    direction: 'recovery',
    now,
  });
  await deps.backend.createRecoverySession(
    {
      sessionId: session.sessionId,
      direction: 'recovery',
      session,
      expiresAt: session.expiresAt,
    },
    now,
  );
  await deps.openBrowser(
    `${deps.webBaseUrl}/memory/recover?session=${encodeURIComponent(session.sessionId)}`,
  );
  const poll = await pollForEnvelope(deps.backend, session.sessionId, {
    sleep,
    now,
    timeoutMs: deps.timeoutMs ?? 5 * 60_000,
    pollMs: deps.pollMs ?? 1500,
  });
  // Terminal, MMK-free failures: a bounded timeout/expiry, or a browser failure signal.
  // Return before any unwrap/recover/enroll so no MMK is produced and nothing is marked
  // recovered. The user can retry the passkey or use their recovery file.
  if (!poll.ok) return { status: 'passkey-failed', reason: poll.reason };
  const failure = asBridgeFailure(poll.envelope);
  if (failure) return { status: 'passkey-failed', reason: failure };
  const mmk = await openMmkFromEnvelope({
    session,
    initiatorPrivateKey,
    envelope: poll.envelope as BridgeEnvelope,
    now,
  });
  const result = await cloudRecover({
    stackHome: deps.stackHome,
    backend: deps.backend,
    mmk,
    ...(options.generation !== undefined
      ? { generation: options.generation }
      : {}),
  });
  // Recovery already succeeded; enroll best-effort (never persists insecure state).
  await enrollDeviceSafe(deps.localKeyStore, mmk);
  await writeLocalRecoveryState(deps.stackHome, {
    schemaVersion: 1,
    recoveredGeneration: result.generation,
    cloudLatestAtRecovery: cloudLatest,
    recoveredAt: now().toISOString(),
    privacyMode: 'protected',
  });
  return {
    status: 'recovered',
    objects: result.objects,
    generation: result.generation,
  };
};
