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
