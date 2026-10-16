import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import type {
  CliAuthStartRequest,
  CliAuthStartResponse,
  CliAuthTokenResponse,
  CloudEnvironmentBundle,
  CommitEnvironmentVersionResponse,
  FinalizeSnapshotResponse,
  GetEnvironmentResponse,
  ListMachinesResponse,
  MachineCheckinRequest,
  MachineCheckinResponse,
  MeResponse,
  PrepareSnapshotResponse,
  SnapshotDownloadResponse,
} from '@stack/spec';

import {
  CloudServiceError,
  bundleInvalid,
  invalidRequest,
  notFound,
  remoteConflict,
  snapshotIntegrity,
  unauthorized,
} from './errors.js';
import type { RemoteMemoryBackend } from '@stack/memory';

import { RemoteConflict } from './repository.js';
import type {
  CliAuthSessionRecord,
  CliAuthSessionStatus,
  CloudBlobStore,
  CloudProfile,
  CloudRepository,
  PublicStackRepository,
  UserStackRepository,
} from './repository.js';
import { createPublicStackService } from './public-service.js';
import { createSkillShareService } from './skill-share-service.js';
import { createUserStackService } from './user-stack-service.js';
import { createMemoryMethods } from './memory-service.js';
import {
  createProductMethods,
  createStandardMemoryProjectCounts,
  type MemoryProjectCounts,
} from './product-service.js';

const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TICKET_TTL_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;

const base64url = (input: Buffer): string =>
  input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromBase64url = (input: string): Buffer =>
  Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
const sha256OfBytes = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export type TicketPayload = {
  k: 'up' | 'dn';
  u: string;
  c: string;
  a?: string;
  s?: number;
  exp: number;
};

export type AuthenticatedUser = { userId: string; tokenId: string };

/**
 * Real-only read model for the CLI "Approve this machine?" screen (shown BEFORE the user
 * clicks Approve). Carries only fields that genuinely exist on {@link CliAuthSessionRecord} —
 * never a fabricated platform/arch. `label` is present only if the CLI user set one.
 */
export type PendingCliAuthSessionView = {
  status: CliAuthSessionStatus;
  label?: string;
  expiresAt: string;
};

export type CloudServiceConfig = {
  repository: CloudRepository & PublicStackRepository & UserStackRepository;
  blobStore: CloudBlobStore;
  appUrl: string;
  ticketSecret: string;
  now?: () => Date;
  randomId?: () => string;
  randomSecret?: () => string;
  sessionTtlMs?: number;
  ticketTtlMs?: number;
  pollIntervalMs?: number;
  maxSnapshotBytes?: number;
  /** Per-user remote Memory backend factory. Absent = Memory API returns 501. */
  memoryBackendFor?: (userId: string) => RemoteMemoryBackend;
  /** P3: injected Standard per-project Memory counts (absent ⇒ unavailable/null). */
  memoryProjectCounts?: MemoryProjectCounts;
};

export type CloudService = ReturnType<typeof createCloudService>;

export const createCloudService = (config: CloudServiceConfig) => {
  const now = () => (config.now ?? (() => new Date()))();
  const nowMs = () => now().getTime();
  const nowIso = () => now().toISOString();
  const newId = config.randomId ?? randomUUID;
  const newSecret = config.randomSecret ?? (() => base64url(randomBytes(32)));
  const sessionTtl = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const ticketTtl = config.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
  const maxSnapshotBytes =
    config.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  const appUrl = config.appUrl.replace(/\/+$/, '');

  /**
   * The one lazy-expiry date comparison, shared by {@link approveCliAuth} and
   * {@link getPendingCliAuthSession} so neither can drift from the other.
   */
  const isPastExpiry = (
    session: Pick<CliAuthSessionRecord, 'expiresAt'>,
  ): boolean => new Date(session.expiresAt).getTime() < nowMs();

  const genUserCode = (): string => {
    const bytes = randomBytes(8);
    const chars = [...bytes].map(
      (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length],
    );
    return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}`;
  };

  const signTicket = (payload: TicketPayload): string => {
    const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const signature = base64url(
      createHmac('sha256', config.ticketSecret).update(body).digest(),
    );
    return `${body}.${signature}`;
  };
  const verifyTicket = (ticket: string): TicketPayload => {
    const [body, signature] = ticket.split('.');
    if (!body || !signature) throw unauthorized('Malformed ticket.');
    const expected = base64url(
      createHmac('sha256', config.ticketSecret).update(body).digest(),
    );
    const given = Buffer.from(signature);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want))
      throw unauthorized('Invalid ticket signature.');
    let payload: TicketPayload;
    try {
      payload = JSON.parse(
        fromBase64url(body).toString('utf8'),
      ) as TicketPayload;
    } catch {
      throw unauthorized('Malformed ticket payload.');
    }
    if (payload.exp < nowMs()) throw unauthorized('Ticket expired.');
    return payload;
  };

  const profileResponse = (profile: CloudProfile | null, userId: string) => ({
    userId,
    ...(profile?.githubUsername
      ? { githubUsername: profile.githubUsername }
      : {}),
    ...(profile?.displayName ? { displayName: profile.displayName } : {}),
    ...(profile?.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  });

  const publicMethods = createPublicStackService({
    repository: config.repository,
    blobStore: config.blobStore,
    nowIso,
    newId,
    appUrl,
  });

  // Reuses the public-Stack publish pipeline as-is (§3) — the only new logic is building a
  // one-item bundle from a private Skill; the commit path, eligibility re-check, and
  // immutability guarantees are exactly `publicMethods.publishPublicStackVersion`'s.
  const skillShareMethods = createSkillShareService({
    repository: config.repository,
    newId,
    resolveHandle: publicMethods.resolveHandle,
    publishPublicStackVersion: publicMethods.publishPublicStackVersion,
    unpublishPublicStack: publicMethods.unpublishPublicStack,
  });

  // Named Stacks (P10B) — publishing one reuses the same public-Stack pipeline (§15).
  const userStackMethods = createUserStackService({
    repository: config.repository,
    newId,
    nowIso,
    resolveHandle: publicMethods.resolveHandle,
    publishPublicStackVersion: publicMethods.publishPublicStackVersion,
    unpublishPublicStack: publicMethods.unpublishPublicStack,
  });

  const memoryMethods = createMemoryMethods({
    ...(config.memoryBackendFor
      ? { memoryBackendFor: config.memoryBackendFor }
      : {}),
    now,
  });

  const productMethods = createProductMethods({
    repository: config.repository,
    blobStore: config.blobStore,
    now,
    newId,
    ...(config.memoryBackendFor
      ? { memoryBackendFor: config.memoryBackendFor }
      : {}),
    // Default to the real Standard deriver when a Memory backend is present; an explicit
    // override still wins (e.g. tests). Protected stays null inside the deriver.
    ...(config.memoryProjectCounts
      ? { memoryProjectCounts: config.memoryProjectCounts }
      : config.memoryBackendFor
        ? {
            memoryProjectCounts: createStandardMemoryProjectCounts(
              config.memoryBackendFor,
            ),
          }
        : {}),
  });

  return {
    ...publicMethods,
    ...memoryMethods,
    ...productMethods,
    ...skillShareMethods,
    ...userStackMethods,
    /** Bearer-token authentication. Derives identity server-side; never trusts the client. */
    authenticate: async (
      authorizationHeader: string | undefined,
    ): Promise<AuthenticatedUser> => {
      const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? '');
      if (!match?.[1])
        throw new CloudServiceError(
          'not-authenticated',
          401,
          'Missing bearer token.',
        );
      const token = await config.repository.findTokenByHash(
        sha256Hex(match[1]),
      );
      if (!token || token.revokedAt)
        throw new CloudServiceError(
          'not-authenticated',
          401,
          'Invalid or revoked token.',
        );
      await config.repository.updateToken(token.tokenId, {
        lastUsedAt: nowIso(),
      });
      return { userId: token.userId, tokenId: token.tokenId };
    },

    /**
     * Phase P1: record a machine check-in. The request is schema-validated and carries
     * only presence (no paths) and no Memory content; identity is the authenticated user,
     * never a request field.
     */
    recordCheckin: async (
      user: AuthenticatedUser,
      request: MachineCheckinRequest,
    ): Promise<MachineCheckinResponse> => {
      // Migration-on-first-authenticated-use: bind this (already authenticated) token to the
      // machine it is checking in as, if it has no binding yet. This lets a pre-P3 token's
      // machine be revoked. A revoked token never reaches here (authenticate rejects it), so a
      // revoked credential cannot re-bind itself. The token is the user's; it is only ever
      // bound to the machine it reports as — never to an arbitrary token from a body field.
      await config.repository.bindTokenMachine(user.tokenId, request.machineId);
      await config.repository.recordCheckin({
        userId: user.userId,
        machineId: request.machineId,
        memoryBackedUp: request.memoryBackedUp,
        skills: request.skills.map((s) => ({
          skillId: s.skillId,
          installedVersion: s.installedVersion,
        })),
        projects: request.projects.map((p) => ({
          projectId: p.projectId,
          present: p.present,
        })),
        now: nowIso(),
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.platform !== undefined
          ? { platform: request.platform }
          : {}),
        ...(request.arch !== undefined ? { arch: request.arch } : {}),
        ...(request.agentsDetected !== undefined
          ? { agentsDetected: request.agentsDetected }
          : {}),
      });
      return { ok: true };
    },

    /** Phase P1: the per-user machine read model (raw facts; status derived by callers). */
    listMachines: async (
      user: AuthenticatedUser,
    ): Promise<ListMachinesResponse> => {
      const states = await config.repository.listMachineStates(user.userId);
      return {
        machines: states.map((m) => ({
          machineId: m.machineId,
          agentsDetected: m.agentsDetected ?? [],
          firstSeenAt: m.firstSeenAt,
          lastCheckinAt: m.lastCheckinAt ?? null,
          memoryBackedUp: m.memoryBackedUp ?? false,
          skills: m.skills.map((s) => ({
            skillId: s.skillId,
            installedVersion: s.installedVersion,
          })),
          projects: m.projects.map((p) => ({
            projectId: p.projectId,
            present: p.present,
          })),
          ...(m.name !== undefined ? { name: m.name } : {}),
          ...(m.platform !== undefined ? { platform: m.platform } : {}),
          ...(m.arch !== undefined ? { arch: m.arch } : {}),
        })),
      };
    },

    startCliAuth: async (
      request: CliAuthStartRequest,
    ): Promise<CliAuthStartResponse> => {
      let userCode = genUserCode();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const existing =
          await config.repository.findAuthSessionByUserCode(userCode);
        if (!existing || existing.status !== 'pending') break;
        userCode = genUserCode();
      }
      const deviceSecret = `stkdev_${newSecret()}`;
      const sessionId = newId();
      const createdAt = nowIso();
      const expiresAt = new Date(nowMs() + sessionTtl).toISOString();
      await config.repository.createAuthSession({
        sessionId,
        userCode,
        deviceSecretHash: sha256Hex(deviceSecret),
        status: 'pending',
        createdAt,
        expiresAt,
        ...(request.machine?.machineId
          ? { machineId: request.machine.machineId }
          : {}),
        ...(request.label ? { label: request.label } : {}),
      });
      return {
        sessionId,
        userCode,
        deviceSecret,
        verificationUri: `${appUrl}/cli`,
        verificationUriComplete: `${appUrl}/cli?code=${encodeURIComponent(userCode)}`,
        expiresAt,
        intervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      };
    },

    pollCliToken: async (
      deviceSecret: string,
    ): Promise<CliAuthTokenResponse> => {
      const session = await config.repository.findAuthSessionByDeviceHash(
        sha256Hex(deviceSecret),
      );
      if (!session) return { status: 'denied' };
      if (session.status === 'denied') return { status: 'denied' };
      if (session.status === 'consumed') return { status: 'denied' };
      if (new Date(session.expiresAt).getTime() < nowMs()) {
        if (session.status !== 'expired')
          await config.repository.updateAuthSession(session.sessionId, {
            status: 'expired',
          });
        return { status: 'expired' };
      }
      if (session.status === 'pending') return { status: 'pending' };
      // status === 'approved': issue the token exactly once.
      if (!session.userId) return { status: 'pending' };
      const plaintext = `stk_${newSecret()}`;
      const tokenId = newId();
      await config.repository.createToken({
        tokenId,
        userId: session.userId,
        tokenHash: sha256Hex(plaintext),
        ...(session.label ? { label: session.label } : {}),
        // Bind the token to its machine (P3) so a machine revoke can target it.
        ...(session.machineId ? { machineId: session.machineId } : {}),
        createdAt: nowIso(),
      });
      await config.repository.updateAuthSession(session.sessionId, {
        status: 'consumed',
      });
      if (session.machineId)
        await config.repository.upsertMachine({
          userId: session.userId,
          machineId: session.machineId,
          firstSeenAt: nowIso(),
        });
      const profile = await config.repository.getProfile(session.userId);
      return {
        status: 'approved',
        token: plaintext,
        tokenId,
        user: profileResponse(profile, session.userId),
      };
    },

    /** Browser-approval. userId derives from the web session, never from the CLI. */
    approveCliAuth: async (input: {
      userCode: string;
      profile: CloudProfile;
    }): Promise<{ approved: true }> => {
      await config.repository.upsertProfile(input.profile);
      const session = await config.repository.findAuthSessionByUserCode(
        input.userCode,
      );
      if (!session) throw notFound('not-found', 'Unknown authorization code.');
      if (isPastExpiry(session)) {
        await config.repository.updateAuthSession(session.sessionId, {
          status: 'expired',
        });
        throw invalidRequest('This authorization code has expired.');
      }
      if (session.status !== 'pending')
        throw invalidRequest(
          'This authorization request is no longer pending.',
        );
      await config.repository.updateAuthSession(session.sessionId, {
        status: 'approved',
        userId: input.profile.userId,
      });
      return { approved: true };
    },

    /**
     * Read-only peek at a pending CLI auth session, used to render the "Approve this
     * machine?" screen truthfully BEFORE the user clicks Approve — including the expired
     * and already-consumed/approved states, without needing a failed approval attempt.
     * Same trust model as the approval page itself: the code is the credential, exactly
     * like `approveCliAuth`'s lookup. Never mutates, except the one legitimate lazy-expiry
     * transition (pending + past `expiresAt` -> `expired`), using the exact same date
     * comparison `approveCliAuth` uses. No platform/arch field exists on the session, so
     * none is read or returned here.
     */
    getPendingCliAuthSession: async (
      userCode: string,
    ): Promise<PendingCliAuthSessionView | null> => {
      const session =
        await config.repository.findAuthSessionByUserCode(userCode);
      if (!session) return null;
      if (session.status === 'pending' && isPastExpiry(session)) {
        await config.repository.updateAuthSession(session.sessionId, {
          status: 'expired',
        });
        return {
          status: 'expired',
          expiresAt: session.expiresAt,
          ...(session.label ? { label: session.label } : {}),
        };
      }
      return {
        status: session.status,
        expiresAt: session.expiresAt,
        ...(session.label ? { label: session.label } : {}),
      };
    },

    revokeToken: async (user: AuthenticatedUser): Promise<void> => {
      await config.repository.updateToken(user.tokenId, {
        revokedAt: nowIso(),
      });
    },

    me: async (user: AuthenticatedUser): Promise<MeResponse> => {
      const handle = await config.repository.getHandleForUser(user.userId);
      return {
        ...profileResponse(
          await config.repository.getProfile(user.userId),
          user.userId,
        ),
        ...(handle ? { handle } : {}),
      };
    },

    getEnvironment: async (
      user: AuthenticatedUser,
      name: string,
    ): Promise<GetEnvironmentResponse> => {
      const environment = await config.repository.getEnvironmentByName(
        user.userId,
        name,
      );
      if (!environment)
        throw notFound(
          'remote-environment-not-found',
          `No cloud Environment named ${name}.`,
        );
      if (!environment.latestVersionId)
        return { environmentId: environment.environmentId, name, latest: null };
      const version = await config.repository.getEnvironmentVersion(
        environment.latestVersionId,
      );
      if (!version || version.userId !== user.userId)
        throw notFound(
          'remote-environment-not-found',
          'Environment version is unavailable.',
        );
      return {
        environmentId: environment.environmentId,
        name,
        latest: {
          version: {
            versionId: version.versionId,
            versionNumber: version.versionNumber,
            digest: version.digest,
            createdAt: version.createdAt,
          },
          bundle: version.bundle,
        },
      };
    },

    commitEnvironmentVersion: async (
      user: AuthenticatedUser,
      name: string,
      input: {
        bundle: CloudEnvironmentBundle;
        expectedLatestVersionId: string | null;
        machineId?: string;
        idempotencyKey?: string;
      },
    ): Promise<CommitEnvironmentVersionResponse> => {
      if (input.bundle.environment.name !== name)
        throw bundleInvalid(
          `Bundle Environment name ${input.bundle.environment.name} does not match ${name}.`,
        );
      if (input.idempotencyKey) {
        const existing = await config.repository.findVersionByIdempotencyKey(
          user.userId,
          input.idempotencyKey,
        );
        if (existing)
          return {
            environmentId: existing.environmentId,
            name,
            version: {
              versionId: existing.versionId,
              versionNumber: existing.versionNumber,
              digest: existing.digest,
              createdAt: existing.createdAt,
            },
            createdNew: false,
          };
      }
      let outcome;
      try {
        outcome = await config.repository.commitEnvironmentVersion({
          userId: user.userId,
          name,
          bundle: input.bundle,
          digest: input.bundle.digest,
          expectedLatestVersionId: input.expectedLatestVersionId,
          ...(input.machineId ? { machineId: input.machineId } : {}),
          ...(input.idempotencyKey
            ? { idempotencyKey: input.idempotencyKey }
            : {}),
          ids: { environmentId: newId(), versionId: newId() },
          now: nowIso(),
        });
      } catch (error) {
        if (error instanceof RemoteConflict)
          throw remoteConflict(error.message);
        throw error;
      }
      if (input.machineId)
        await config.repository.upsertMachine({
          userId: user.userId,
          machineId: input.machineId,
          firstSeenAt: nowIso(),
          lastSyncedAt: nowIso(),
        });
      return {
        environmentId: outcome.environment.environmentId,
        name,
        version: {
          versionId: outcome.version.versionId,
          versionNumber: outcome.version.versionNumber,
          digest: outcome.version.digest,
          createdAt: outcome.version.createdAt,
        },
        createdNew: outcome.createdNew,
      };
    },

    prepareSnapshot: async (
      user: AuthenticatedUser,
      input: { contentHash: string; archiveHash: string; byteSize: number },
    ): Promise<PrepareSnapshotResponse> => {
      if (input.byteSize > maxSnapshotBytes)
        throw invalidRequest(
          `Snapshot exceeds the ${maxSnapshotBytes}-byte limit.`,
        );
      if (await config.repository.hasSnapshot(user.userId, input.contentHash))
        return { status: 'exists' };
      return {
        status: 'upload',
        uploadTicket: signTicket({
          k: 'up',
          u: user.userId,
          c: input.contentHash,
          a: input.archiveHash,
          s: input.byteSize,
          exp: nowMs() + ticketTtl,
        }),
      };
    },

    uploadSnapshotBlob: async (
      user: AuthenticatedUser,
      uploadTicket: string,
      bytes: Uint8Array,
    ): Promise<void> => {
      const payload = verifyTicket(uploadTicket);
      if (payload.k !== 'up' || payload.u !== user.userId)
        throw unauthorized('Upload ticket does not belong to you.');
      if (bytes.length > maxSnapshotBytes)
        throw invalidRequest('Uploaded snapshot exceeds the size limit.');
      if (payload.s !== undefined && bytes.length !== payload.s)
        throw snapshotIntegrity(
          'Uploaded byte size does not match the ticket.',
        );
      await config.blobStore.putPending(uploadTicket, bytes);
    },

    finalizeSnapshot: async (
      user: AuthenticatedUser,
      input: {
        contentHash: string;
        archiveHash: string;
        byteSize: number;
        uploadTicket: string;
      },
    ): Promise<FinalizeSnapshotResponse> => {
      const payload = verifyTicket(input.uploadTicket);
      if (
        payload.k !== 'up' ||
        payload.u !== user.userId ||
        payload.c !== input.contentHash ||
        payload.a !== input.archiveHash ||
        payload.s !== input.byteSize
      )
        throw unauthorized('Upload ticket does not match this snapshot.');
      const bytes = await config.blobStore.getPending(input.uploadTicket);
      if (!bytes)
        throw snapshotIntegrity(
          'No uploaded bytes were found for this ticket.',
        );
      if (bytes.length !== input.byteSize)
        throw snapshotIntegrity('Uploaded byte size mismatch.');
      if (sha256OfBytes(bytes) !== input.archiveHash)
        throw snapshotIntegrity('Uploaded archive checksum mismatch.');
      if (
        !(await config.repository.hasSnapshot(user.userId, input.contentHash))
      ) {
        await config.blobStore.put(user.userId, input.contentHash, bytes);
        await config.repository.putSnapshot({
          userId: user.userId,
          contentHash: input.contentHash,
          archiveHash: input.archiveHash,
          byteSize: input.byteSize,
          createdAt: nowIso(),
        });
      }
      await config.blobStore.deletePending(input.uploadTicket);
      return { contentHash: input.contentHash, stored: true };
    },

    requestSnapshotDownload: async (
      user: AuthenticatedUser,
      contentHash: string,
    ): Promise<SnapshotDownloadResponse> => {
      const snapshot = await config.repository.getSnapshot(
        user.userId,
        contentHash,
      );
      if (!snapshot)
        throw notFound('snapshot-not-found', 'Snapshot not found.');
      return {
        contentHash,
        archiveHash: snapshot.archiveHash,
        byteSize: snapshot.byteSize,
        downloadTicket: signTicket({
          k: 'dn',
          u: user.userId,
          c: contentHash,
          exp: nowMs() + ticketTtl,
        }),
      };
    },

    getSnapshotBlob: async (
      user: AuthenticatedUser,
      downloadTicket: string,
    ): Promise<Uint8Array> => {
      const payload = verifyTicket(downloadTicket);
      if (payload.k !== 'dn' || payload.u !== user.userId)
        throw unauthorized('Download ticket does not belong to you.');
      const bytes = await config.blobStore.get(user.userId, payload.c);
      if (!bytes) throw notFound('snapshot-not-found', 'Snapshot not found.');
      return bytes;
    },
  };
};
