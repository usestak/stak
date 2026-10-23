import type { CloudErrorCode } from '@stack/spec';

export class CloudServiceError extends Error {
  constructor(
    public readonly code: CloudErrorCode,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'CloudServiceError';
  }
}

export const notAuthenticated = (
  message = 'A valid Stack CLI token is required.',
) => new CloudServiceError('not-authenticated', 401, message);
export const unauthorized = (
  message = 'You are not authorized for this resource.',
) => new CloudServiceError('cloud-unauthorized', 403, message);
export const invalidRequest = (message: string) =>
  new CloudServiceError('invalid-request', 400, message);
export const notFound = (
  code: CloudErrorCode = 'not-found',
  message = 'Not found.',
) => new CloudServiceError(code, 404, message);
export const remoteConflict = (message: string) =>
  new CloudServiceError('remote-environment-conflict', 409, message);
export const commitFailed = (message: string) =>
  new CloudServiceError('cloud-version-commit-failed', 500, message);
export const bundleInvalid = (message: string) =>
  new CloudServiceError('cloud-bundle-invalid', 400, message);
export const snapshotIntegrity = (message: string) =>
  new CloudServiceError('snapshot-integrity-mismatch', 400, message);
export const publicStackNotFound = (message = 'Public Stack not found.') =>
  new CloudServiceError('public-stack-not-found', 404, message);
export const publicStackConflict = (message: string) =>
  new CloudServiceError('public-stack-conflict', 409, message);
export const publicationNotEligible = (message: string) =>
  new CloudServiceError('publication-not-eligible', 422, message);
export const invalidSlug = (message: string) =>
  new CloudServiceError('invalid-slug', 400, message);
export const handleUnavailable = (message: string) =>
  new CloudServiceError('handle-unavailable', 409, message);
export const userStackNotFound = (message = 'No such Stack.') =>
  new CloudServiceError('user-stack-not-found', 404, message);
export const userStackConflict = (message: string) =>
  new CloudServiceError('user-stack-conflict', 409, message);
export const userStackNameConflict = (message: string) =>
  new CloudServiceError('user-stack-name-conflict', 409, message);
export const publicSlugTaken = (message: string) =>
  new CloudServiceError('public-slug-taken', 409, message);

// --- remote Memory ---
export const memoryNotConfigured = (
  message = 'Remote Memory is not enabled on this server.',
) => new CloudServiceError('memory-not-configured', 501, message);
export const memoryNotFound = (message = 'Memory backup not found.') =>
  new CloudServiceError('memory-not-found', 404, message);
export const memoryConflict = (message: string) =>
  new CloudServiceError('memory-conflict', 409, message);
export const memoryTooLarge = (message = 'Memory payload is too large.') =>
  new CloudServiceError('memory-too-large', 413, message);
export const memoryIntegrity = (message = 'Memory payload failed integrity.') =>
  new CloudServiceError('memory-integrity', 400, message);
export const memoryNotProtected = (message: string) =>
  new CloudServiceError('memory-not-protected', 400, message);
export const memorySessionConsumed = (
  message = 'Recovery session already used.',
) => new CloudServiceError('memory-session-consumed', 409, message);
export const memorySessionExpired = (message = 'Recovery session expired.') =>
  new CloudServiceError('memory-session-expired', 410, message);
export const memoryNoEnvelope = (
  message = 'No recovery envelope submitted yet.',
) => new CloudServiceError('memory-no-envelope', 409, message);
export const memoryIncompatibleFormat = (
  message = 'This account’s Memory was upgraded by a newer STAK CLI. Update with `npm i -g @memstk/cli@beta`.',
) => new CloudServiceError('memory-incompatible-format', 409, message);
