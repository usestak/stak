import {
  approveSkillVersionRequestSchema,
  cliAuthStartRequestSchema,
  machineCheckinRequestSchema,
  cliAuthTokenRequestSchema,
  commitEnvironmentVersionRequestSchema,
  finalizeSnapshotRequestSchema,
  memoryAddRecoveryMethodRequestSchema,
  memoryCreateGenerationRequestSchema,
  memoryCreateSessionRequestSchema,
  memoryEnsureProfileRequestSchema,
  memorySetPrivacyModeRequestSchema,
  memorySubmitEnvelopeRequestSchema,
  prepareSnapshotRequestSchema,
  publishPublicStackVersionRequestSchema,
  setProjectLifecycleRequestSchema,
  setSkillPausedRequestSchema,
  syncProjectsRequestSchema,
} from '@stack/spec';

import { CloudServiceError } from './errors.js';
import type { AuthenticatedUser, CloudService } from './service.js';

export type CloudRequest = {
  method: string;
  path: string;
  headers?: Record<string, string | undefined>;
  jsonBody?: unknown;
  binaryBody?: Uint8Array;
};
export type CloudResponse = {
  status: number;
  headers: Record<string, string>;
  jsonBody?: unknown;
  binaryBody?: Uint8Array;
};

const json = (status: number, body: unknown): CloudResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  jsonBody: body,
});
const errorResponse = (
  status: number,
  code: string,
  message: string,
): CloudResponse => json(status, { error: { code, message } });

const segmentsOf = (path: string): string[] => {
  const clean = path.split('?')[0] ?? '';
  const parts = clean.split('/').filter(Boolean);
  const versionIndex = parts.findIndex((part) => part === 'v1');
  const rest = versionIndex >= 0 ? parts.slice(versionIndex + 1) : parts;
  return rest.map((part) => decodeURIComponent(part));
};

/**
 * Framework-agnostic router for the versioned Cloud API. Next.js route handlers
 * (or any transport) adapt their request into a {@link CloudRequest} and render
 * the {@link CloudResponse}. All authorization is derived from the bearer token.
 */
export const handleCloudRequest = async (
  service: CloudService,
  request: CloudRequest,
): Promise<CloudResponse> => {
  const method = request.method.toUpperCase();
  const segments = segmentsOf(request.path);
  const header = (name: string) => request.headers?.[name.toLowerCase()];

  const authenticate = async (): Promise<AuthenticatedUser> =>
    service.authenticate(header('authorization'));

  try {
    // --- Auth (unauthenticated) ---
    if (method === 'POST' && matches(segments, ['cli', 'auth', 'start']))
      return json(
        200,
        await service.startCliAuth(
          cliAuthStartRequestSchema.parse(request.jsonBody ?? {}),
        ),
      );
    if (method === 'POST' && matches(segments, ['cli', 'auth', 'token'])) {
      const body = cliAuthTokenRequestSchema.parse(request.jsonBody ?? {});
      return json(200, await service.pollCliToken(body.deviceSecret));
    }
    if (method === 'POST' && matches(segments, ['cli', 'auth', 'revoke'])) {
      await service.revokeToken(await authenticate());
      return json(200, { revoked: true });
    }

    // --- Identity ---
    if (method === 'GET' && matches(segments, ['me']))
      return json(200, await service.me(await authenticate()));

    // --- Machines (Phase P1 check-in) ---
    if (method === 'POST' && matches(segments, ['machines', 'checkin'])) {
      const user = await authenticate();
      const body = machineCheckinRequestSchema.parse(request.jsonBody ?? {});
      return json(200, await service.recordCheckin(user, body));
    }
    if (method === 'GET' && matches(segments, ['machines']))
      return json(200, await service.listMachines(await authenticate()));

    // --- P3 product read models + account-side writes (all authenticated) ---
    if (method === 'GET' && matches(segments, ['overview'])) {
      const user = await authenticate();
      const machine = new URL(request.path, 'http://x').searchParams.get(
        'machine',
      );
      return json(200, await service.getOverview(user, machine ?? undefined));
    }
    if (method === 'GET' && matches(segments, ['skills']))
      return json(200, await service.getSkillsReadModel(await authenticate()));
    if (method === 'GET' && segments.length === 2 && segments[0] === 'skills')
      return json(
        200,
        await service.getSkillDetail(await authenticate(), segments[1] ?? ''),
      );
    if (
      method === 'POST' &&
      segments.length === 3 &&
      segments[0] === 'skills' &&
      segments[2] === 'approve'
    ) {
      const user = await authenticate();
      const body = approveSkillVersionRequestSchema.parse({
        skillId: segments[1],
        ...(typeof request.jsonBody === 'object' && request.jsonBody
          ? request.jsonBody
          : {}),
      });
      return json(200, await service.approveSkillVersion(user, body));
    }
    if (
      method === 'POST' &&
      segments.length === 3 &&
      segments[0] === 'skills' &&
      segments[2] === 'pause'
    ) {
      const user = await authenticate();
      const body = setSkillPausedRequestSchema.parse({
        skillId: segments[1],
        ...(typeof request.jsonBody === 'object' && request.jsonBody
          ? request.jsonBody
          : {}),
      });
      return json(200, await service.setSkillPaused(user, body));
    }
    if (method === 'GET' && matches(segments, ['machines', 'view']))
      return json(
        200,
        await service.getMachinesReadModel(await authenticate()),
      );
    if (
      method === 'POST' &&
      segments.length === 3 &&
      segments[0] === 'machines' &&
      segments[2] === 'revoke'
    )
      return json(
        200,
        await service.revokeMachine(await authenticate(), segments[1] ?? ''),
      );
    if (method === 'GET' && matches(segments, ['projects']))
      return json(
        200,
        await service.getProjectsReadModel(await authenticate()),
      );
    if (method === 'POST' && matches(segments, ['projects', 'sync'])) {
      const user = await authenticate();
      const body = syncProjectsRequestSchema.parse(request.jsonBody ?? {});
      return json(200, await service.syncProjects(user, body));
    }
    if (
      method === 'POST' &&
      segments.length === 3 &&
      segments[0] === 'projects' &&
      segments[2] === 'lifecycle'
    ) {
      const user = await authenticate();
      const body = setProjectLifecycleRequestSchema.parse({
        projectId: segments[1],
        ...(typeof request.jsonBody === 'object' && request.jsonBody
          ? request.jsonBody
          : {}),
      });
      return json(
        200,
        await service.setProjectLifecycle(user, body.projectId, body.lifecycle),
      );
    }
    if (method === 'GET' && matches(segments, ['stacks-owned']))
      return json(200, await service.getStacksReadModel(await authenticate()));
    if (method === 'GET' && matches(segments, ['activity']))
      return json(
        200,
        await service.getActivityReadModel(await authenticate()),
      );

    // --- Environments ---
    if (
      method === 'GET' &&
      segments.length === 2 &&
      segments[0] === 'environments'
    )
      return json(
        200,
        await service.getEnvironment(await authenticate(), segments[1] ?? ''),
      );
    if (
      method === 'POST' &&
      segments.length === 3 &&
      segments[0] === 'environments' &&
      segments[2] === 'versions'
    ) {
      const user = await authenticate();
      const body = commitEnvironmentVersionRequestSchema.parse(
        request.jsonBody ?? {},
      );
      return json(
        200,
        await service.commitEnvironmentVersion(user, segments[1] ?? '', {
          bundle: body.bundle,
          expectedLatestVersionId: body.expectedLatestVersionId,
          ...(body.machineId ? { machineId: body.machineId } : {}),
          ...(body.idempotencyKey
            ? { idempotencyKey: body.idempotencyKey }
            : {}),
        }),
      );
    }

    // --- Snapshots ---
    if (method === 'POST' && matches(segments, ['snapshots', 'prepare'])) {
      const user = await authenticate();
      const body = prepareSnapshotRequestSchema.parse(request.jsonBody ?? {});
      return json(200, await service.prepareSnapshot(user, body));
    }
    if (
      method === 'PUT' &&
      segments.length === 3 &&
      segments[0] === 'snapshots' &&
      segments[1] === 'upload'
    ) {
      const user = await authenticate();
      if (!request.binaryBody)
        return errorResponse(400, 'invalid-request', 'Missing upload body.');
      await service.uploadSnapshotBlob(
        user,
        segments[2] ?? '',
        request.binaryBody,
      );
      return { status: 204, headers: {} };
    }
    if (method === 'POST' && matches(segments, ['snapshots', 'finalize'])) {
      const user = await authenticate();
      const body = finalizeSnapshotRequestSchema.parse(request.jsonBody ?? {});
      return json(200, await service.finalizeSnapshot(user, body));
    }
    if (
      method === 'GET' &&
      segments.length === 3 &&
      segments[0] === 'snapshots' &&
      segments[2] === 'download'
    ) {
      const user = await authenticate();
      return json(
        200,
        await service.requestSnapshotDownload(user, segments[1] ?? ''),
      );
    }
    if (
      method === 'GET' &&
      segments.length === 3 &&
      segments[0] === 'snapshots' &&
      segments[1] === 'blob'
    ) {
      const user = await authenticate();
      const bytes = await service.getSnapshotBlob(user, segments[2] ?? '');
      return {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        binaryBody: bytes,
      };
    }

    // --- Public Stacks (reads are unauthenticated) ---
    if (
      method === 'POST' &&
      segments.length === 3 &&
      segments[0] === 'stacks' &&
      segments[2] === 'versions'
    ) {
      const user = await authenticate();
      const body = publishPublicStackVersionRequestSchema.parse(
        request.jsonBody ?? {},
      );
      if (body.slug !== segments[1])
        return errorResponse(
          400,
          'invalid-slug',
          'Request slug does not match the route.',
        );
      return json(200, await service.publishPublicStackVersion(user, body));
    }
    if (method === 'GET' && segments.length === 3 && segments[0] === 'stacks')
      return json(
        200,
        await service.getPublicStack(segments[1] ?? '', segments[2] ?? ''),
      );
    if (
      method === 'GET' &&
      segments.length === 5 &&
      segments[0] === 'stacks' &&
      segments[3] === 'versions'
    ) {
      const versionNumber = Number.parseInt(segments[4] ?? '', 10);
      if (!Number.isInteger(versionNumber) || versionNumber < 1)
        return errorResponse(400, 'invalid-request', 'Invalid version number.');
      return json(
        200,
        await service.getPublicStackVersion(
          segments[1] ?? '',
          segments[2] ?? '',
          versionNumber,
        ),
      );
    }
    if (method === 'GET' && segments.length === 2 && segments[0] === 'profiles')
      return json(200, await service.getPublicProfile(segments[1] ?? ''));

    // --- Remote Memory (all authenticated) ---
    if (segments[0] === 'memory') {
      const rest = segments.slice(1);
      // P3 product read model + narrow destructive delete.
      if (method === 'GET' && matches(rest, ['view']))
        return json(
          200,
          await service.getMemoryReadModel(await authenticate()),
        );
      if (method === 'POST' && matches(rest, ['delete']))
        return json(200, await service.deleteCloudMemory(await authenticate()));
      if (method === 'GET' && matches(rest, ['profile']))
        return json(200, await service.memoryGetProfile(await authenticate()));
      if (method === 'POST' && matches(rest, ['profile-ensure'])) {
        const user = await authenticate();
        const body = memoryEnsureProfileRequestSchema.parse(
          request.jsonBody ?? {},
        );
        return json(
          200,
          await service.memoryEnsureProfile(user, body.formatVersion),
        );
      }
      if (method === 'POST' && matches(rest, ['privacy'])) {
        const user = await authenticate();
        const body = memorySetPrivacyModeRequestSchema.parse(
          request.jsonBody ?? {},
        );
        return json(
          200,
          await service.memorySetPrivacyMode(user, body.privacyMode),
        );
      }
      if (method === 'GET' && matches(rest, ['generations']))
        return json(
          200,
          await service.memoryListGenerations(await authenticate()),
        );
      if (method === 'GET' && matches(rest, ['latest']))
        return json(200, await service.memoryGetLatest(await authenticate()));
      if (method === 'POST' && matches(rest, ['generations'])) {
        const user = await authenticate();
        const body = memoryCreateGenerationRequestSchema.parse(
          request.jsonBody ?? {},
        );
        return json(200, await service.memoryCreateGeneration(user, body));
      }
      if (method === 'GET' && rest.length === 2 && rest[0] === 'by-number') {
        const generation = Number.parseInt(rest[1] ?? '', 10);
        if (!Number.isInteger(generation) || generation < 0)
          return errorResponse(
            400,
            'invalid-request',
            'Invalid generation number.',
          );
        return json(
          200,
          await service.memoryGetGeneration(await authenticate(), generation),
        );
      }
      if (
        method === 'GET' &&
        rest.length === 3 &&
        rest[0] === 'generations' &&
        rest[2] === 'payload'
      )
        return json(
          200,
          await service.memoryGetPayload(await authenticate(), rest[1] ?? ''),
        );
      if (
        method === 'POST' &&
        rest.length === 3 &&
        rest[0] === 'generations' &&
        rest[2] === 'retire'
      )
        return json(
          200,
          await service.memoryRetireGeneration(
            await authenticate(),
            rest[1] ?? '',
          ),
        );
      if (method === 'GET' && rest.length === 2 && rest[0] === 'generations')
        return json(
          200,
          await service.memoryGetGenerationById(
            await authenticate(),
            rest[1] ?? '',
          ),
        );
      if (method === 'GET' && matches(rest, ['recovery-methods']))
        return json(
          200,
          await service.memoryListRecoveryMethods(await authenticate()),
        );
      if (method === 'POST' && matches(rest, ['recovery-methods'])) {
        const user = await authenticate();
        const body = memoryAddRecoveryMethodRequestSchema.parse(
          request.jsonBody ?? {},
        );
        return json(200, await service.memoryAddRecoveryMethod(user, body));
      }
      if (
        method === 'POST' &&
        rest.length === 3 &&
        rest[0] === 'recovery-methods' &&
        rest[2] === 'revoke'
      )
        return json(
          200,
          await service.memoryRevokeRecoveryMethod(
            await authenticate(),
            rest[1] ?? '',
          ),
        );
      if (method === 'POST' && matches(rest, ['sessions'])) {
        const user = await authenticate();
        const body = memoryCreateSessionRequestSchema.parse(
          request.jsonBody ?? {},
        );
        return json(200, await service.memoryCreateSession(user, body));
      }
      if (method === 'GET' && rest.length === 2 && rest[0] === 'sessions')
        return json(
          200,
          await service.memoryGetSession(await authenticate(), rest[1] ?? ''),
        );
      if (
        method === 'POST' &&
        rest.length === 3 &&
        rest[0] === 'sessions' &&
        rest[2] === 'envelope'
      ) {
        const user = await authenticate();
        const body = memorySubmitEnvelopeRequestSchema.parse(
          request.jsonBody ?? {},
        );
        return json(
          200,
          await service.memorySubmitEnvelope(
            user,
            rest[1] ?? '',
            body.envelope,
          ),
        );
      }
      if (
        method === 'POST' &&
        rest.length === 3 &&
        rest[0] === 'sessions' &&
        rest[2] === 'consume'
      )
        return json(
          200,
          await service.memoryConsumeSession(
            await authenticate(),
            rest[1] ?? '',
          ),
        );
    }

    return errorResponse(404, 'not-found', 'Unknown STAK Cloud route.');
  } catch (error) {
    if (error instanceof CloudServiceError)
      return errorResponse(error.httpStatus, error.code, error.message);
    if (isZodError(error))
      return errorResponse(400, 'invalid-request', 'Invalid request payload.');
    return errorResponse(
      500,
      'cloud-version-commit-failed',
      error instanceof Error ? error.message : 'Internal error.',
    );
  }
};

const matches = (segments: string[], expected: string[]): boolean =>
  segments.length === expected.length &&
  expected.every((part, index) => segments[index] === part);

const isZodError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { name?: string }).name === 'ZodError';
