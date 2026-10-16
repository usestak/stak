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
  reportSkillSourceCheckRequestSchema,
  setProjectLifecycleRequestSchema,
  setSkillPausedRequestSchema,
  syncProjectsRequestSchema,
  uploadSkillReviewArtifactRequestSchema,
  createUserStackRequestSchema,
  updateUserStackRequestSchema,
  publishUserStackRequestSchema,
} from '@stack/spec';

import { CloudServiceError, invalidRequest } from './errors.js';
import { MAX_REVIEW_PAYLOAD_BYTES } from './product-service.js';
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
      // Strict schema: the body may carry ONLY { reviewArtifactId } — the candidate being
      // approved is read from Cloud's stored artifact, never from the client.
      const body = approveSkillVersionRequestSchema.parse(
        withRouteSkillId(segments[1], request.jsonBody),
      );
      return json(200, await service.approveSkillVersion(user, body));
    }
    // P5a: CLI-reported source-check results (Cloud never resolves sources itself).
    if (
      method === 'POST' &&
      segments.length === 3 &&
      segments[0] === 'skills' &&
      segments[2] === 'review-check'
    ) {
      const user = await authenticate();
      const body = reportSkillSourceCheckRequestSchema.parse(
        withRouteSkillId(segments[1], request.jsonBody),
      );
      return json(200, await service.reportSkillSourceCheck(user, body));
    }
    if (
      method === 'POST' &&
      segments.length === 3 &&
      segments[0] === 'skills' &&
      segments[2] === 'review-artifact'
    ) {
      const user = await authenticate();
      // Wire shape: one JSON body = the upload metadata plus `payloadBase64`, the exact bytes
      // of the bounded text payload (the transport adapter delivers POST bodies as JSON only).
      // The service rehashes those decoded bytes against `artifactPayloadHash`.
      const { payloadBase64, ...metadata } = withRouteSkillId(
        segments[1],
        request.jsonBody,
      );
      if (typeof payloadBase64 !== 'string')
        return errorResponse(
          400,
          'invalid-request',
          'Missing review payload (payloadBase64).',
        );
      if (payloadBase64.length > MAX_REVIEW_PAYLOAD_BASE64_LENGTH)
        return errorResponse(
          400,
          'invalid-request',
          'Review payload exceeds the size bound.',
        );
      const body = uploadSkillReviewArtifactRequestSchema.parse(metadata);
      return json(
        200,
        await service.uploadSkillReviewArtifact(
          user,
          body,
          new Uint8Array(Buffer.from(payloadBase64, 'base64')),
        ),
      );
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

    // --- Named Stacks (P10B §11-15): private, account-owned Stack CRUD + §14 use-by-name ---
    if (
      method === 'GET' &&
      segments.length === 1 &&
      segments[0] === 'user-stacks'
    )
      return json(200, await service.listUserStacks(await authenticate()));
    if (
      method === 'POST' &&
      segments.length === 1 &&
      segments[0] === 'user-stacks'
    ) {
      const user = await authenticate();
      const body = createUserStackRequestSchema.parse(request.jsonBody ?? {});
      return json(200, await service.createUserStack(user, body));
    }
    if (
      method === 'GET' &&
      segments.length === 3 &&
      segments[0] === 'user-stacks' &&
      segments[1] === 'id'
    ) {
      const user = await authenticate();
      return json(200, await service.getUserStack(user, segments[2] ?? ''));
    }
    if (
      method === 'PATCH' &&
      segments.length === 3 &&
      segments[0] === 'user-stacks' &&
      segments[1] === 'id'
    ) {
      const user = await authenticate();
      const body = updateUserStackRequestSchema.parse(request.jsonBody ?? {});
      if (body.stackId !== segments[2])
        return errorResponse(
          400,
          'invalid-request',
          'Request stackId does not match the route.',
        );
      return json(200, await service.updateUserStack(user, body));
    }
    if (
      method === 'POST' &&
      segments.length === 4 &&
      segments[0] === 'user-stacks' &&
      segments[1] === 'id' &&
      segments[3] === 'publish'
    ) {
      const user = await authenticate();
      const body = publishUserStackRequestSchema.parse(request.jsonBody ?? {});
      if (body.stackId !== segments[2])
        return errorResponse(
          400,
          'invalid-request',
          'Request stackId does not match the route.',
        );
      return json(200, await service.publishUserStack(user, body));
    }
    // owner-authenticated fetch-by-name for `stak use <name>` (§14)
    if (
      method === 'GET' &&
      segments.length === 2 &&
      segments[0] === 'user-stacks'
    ) {
      const user = await authenticate();
      const name = decodeURIComponent(segments[1] ?? '');
      return json(200, await service.getUserStackByName(user, name));
    }
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
    // Hybrid Public Skill Portability: anonymous binary snapshot fetch — NO `authenticate()`
    // call. Authorization is entirely `getPublicSkillSnapshot`'s job (owner/slug/version must
    // resolve to a currently-published public Stack, and contentHash must belong to THAT
    // exact version's own bundle); guessing a hash can never reach an unpublished or
    // owner-private snapshot. Mirrors the private authenticated download route's binary
    // response shape above.
    if (
      method === 'GET' &&
      segments.length === 7 &&
      segments[0] === 'stacks' &&
      segments[3] === 'versions' &&
      segments[5] === 'snapshots'
    ) {
      const versionNumber = Number.parseInt(segments[4] ?? '', 10);
      if (!Number.isInteger(versionNumber) || versionNumber < 1)
        return errorResponse(400, 'invalid-request', 'Invalid version number.');
      try {
        const bytes = await service.getPublicSkillSnapshot(
          segments[1] ?? '',
          segments[2] ?? '',
          versionNumber,
          segments[6] ?? '',
        );
        return {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            // Content is immutable, but public ACCESS is revocable: unpublishing the Stack
            // must take effect immediately, and a CDN holding a long-lived cached copy of
            // this response would keep serving it after unpublish, bypassing the
            // application-layer publication check in `getPublicSkillSnapshot`. `no-store`
            // (not just a short max-age) so no intermediary is ever load-bearing for that
            // invariant.
            'cache-control': 'no-store',
          },
          binaryBody: bytes,
        };
      } catch (error) {
        if (error instanceof CloudServiceError) {
          // Negative-cache safety: every invalid/private/unpublished case 404s identically
          // (never revealing whether the underlying private blob exists — see
          // `getPublicSkillSnapshot`'s own comment), and that 404 must NEVER be cached long
          // enough to survive a later valid publish at this same URL — e.g. a consumer
          // hitting this route before the owner's first publish completes. `no-store` is
          // explicit rather than relying on CDN/Vercel defaults, which can vary by deployment
          // target and must not be load-bearing for this invariant.
          return {
            status: error.httpStatus,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            },
            jsonBody: { error: { code: error.code, message: error.message } },
          };
        }
        throw error;
      }
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

/** Base64 length of the largest review payload the service accepts (4 chars per 3 bytes). */
const MAX_REVIEW_PAYLOAD_BASE64_LENGTH =
  Math.ceil(MAX_REVIEW_PAYLOAD_BYTES / 3) * 4;

/**
 * Merge the route's Skill id into a JSON body. The route is authoritative: a body that names a
 * DIFFERENT skillId is rejected rather than silently overriding (or being overridden by) it.
 */
const withRouteSkillId = (
  skillId: string | undefined,
  jsonBody: unknown,
): Record<string, unknown> => {
  const body =
    typeof jsonBody === 'object' &&
    jsonBody !== null &&
    !Array.isArray(jsonBody)
      ? (jsonBody as Record<string, unknown>)
      : {};
  if (body.skillId !== undefined && body.skillId !== skillId)
    throw invalidRequest('Request skillId does not match the route.');
  return { ...body, skillId };
};

const matches = (segments: string[], expected: string[]): boolean =>
  segments.length === expected.length &&
  expected.every((part, index) => segments[index] === part);

const isZodError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { name?: string }).name === 'ZodError';
