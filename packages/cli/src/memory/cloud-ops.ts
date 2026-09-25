/**
 * CLI operations for remote Stack Memory (Phase 14B). Encodes the product rules:
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
  cloudRecover,
  generateMmk,
  migrateStandardToProtected,
  newKeyring,
  protectedCloudBackup,
  standardCloudBackup,
  unwrapWithRecoveryKey,
  type BackupResult,
  type LocalMemoryKeyStore,
  type MmkKeyring,
  type MmkWrapper,
  type RecoveryKeyArtifacts,
  type RemoteMemoryBackend,
} from '@stack/memory';

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

/** How the MMK wrapper is stored inside a cloud recovery method (opaque to server). */
type StoredWrapper = { mmkId: string; wrapper: MmkWrapper };

const isStoredWrapper = (value: unknown): value is StoredWrapper =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { mmkId?: unknown }).mmkId === 'string' &&
  typeof (value as { wrapper?: unknown }).wrapper === 'object';

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

  if (meta.privacyMode === 'standard') {
    const result = await cloudRecover({
      stackHome: deps.stackHome,
      backend: deps.backend,
      ...(options.generation !== undefined
        ? { generation: options.generation }
        : {}),
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
  if (!mmk && options.recoveryKey) {
    mmk = await unlockMmkWithRecoveryKey(deps.backend, options.recoveryKey);
    if (mmk) await deps.localKeyStore.saveMmk(mmk); // enroll this device
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

export type ProtectOutcome = {
  migrated: number;
  recoveryMethod: 'recovery-file';
};

/** Enable Protected: new MMK + recovery-file method + device enrollment + migrate. */
export const runMemoryCloudProtect = async (
  deps: MemoryCloudDeps & { backend: RemoteMemoryBackend },
  options: { recoveryKey: RecoveryKeyArtifacts },
): Promise<ProtectOutcome> => {
  const mmk = generateMmk();
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
  await deps.localKeyStore.saveMmk(mmk); // this device can now back up Protected
  const migration = await migrateStandardToProtected({
    backend: deps.backend,
    mmk,
    ...(deps.now ? { now: deps.now } : {}),
  });
  return { migrated: migration.migrated, recoveryMethod: 'recovery-file' };
};

export type MemoryCloudStatus = {
  authenticated: boolean;
  privacyMode: 'standard' | 'protected' | null;
  latestGeneration: number | null;
  lastCloudBackupAt: string | null;
  recoveryMethodTypes: string[];
  deviceEnrolled: boolean;
};

export const readMemoryCloudStatus = async (
  deps: MemoryCloudDeps,
): Promise<MemoryCloudStatus> => {
  const deviceEnrolled = await deps.localKeyStore.hasKey();
  if (!deps.backend)
    return {
      authenticated: false,
      privacyMode: null,
      latestGeneration: null,
      lastCloudBackupAt: null,
      recoveryMethodTypes: [],
      deviceEnrolled,
    };
  const profile = await deps.backend.getProfile();
  const latest = await deps.backend.getLatest();
  const methods = await deps.backend.listRecoveryMethods();
  return {
    authenticated: true,
    privacyMode: profile?.privacyMode ?? null,
    latestGeneration: profile?.latestGeneration ?? null,
    lastCloudBackupAt: latest?.createdAt ?? null,
    recoveryMethodTypes: [...new Set(methods.map((method) => method.type))],
    deviceEnrolled,
  };
};
