import type { CloudErrorCode } from '@stack/spec';

export class StackCloudError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StackCloudError';
  }
}

export class NotAuthenticatedError extends StackCloudError {
  constructor(message = 'Not signed in. Run stak login first.') {
    super('not-authenticated', message);
    this.name = 'NotAuthenticatedError';
  }
}
export class AuthenticationExpiredError extends StackCloudError {
  constructor(
    message = 'Your STAK session has expired. Run stak login again.',
  ) {
    super('authentication-expired', message);
    this.name = 'AuthenticationExpiredError';
  }
}
export class CloudUnavailableError extends StackCloudError {
  constructor(message = 'STAK Cloud is unavailable.', options?: ErrorOptions) {
    super('cloud-unavailable', message, options);
    this.name = 'CloudUnavailableError';
  }
}
export class CloudUnauthorizedError extends StackCloudError {
  constructor(
    message = 'You are not authorized for this STAK Cloud resource.',
  ) {
    super('cloud-unauthorized', message);
    this.name = 'CloudUnauthorizedError';
  }
}
export class CloudNotConfiguredError extends StackCloudError {
  constructor(
    message = 'STAK Cloud is not configured. Set STACK_API_URL to a STAK Cloud endpoint.',
  ) {
    super('cloud-not-configured', message);
    this.name = 'CloudNotConfiguredError';
  }
}
export class RemoteEnvironmentNotFoundError extends StackCloudError {
  constructor(message = 'The remote Environment does not exist.') {
    super('remote-environment-not-found', message);
    this.name = 'RemoteEnvironmentNotFoundError';
  }
}
export class RemoteEnvironmentConflictError extends StackCloudError {
  constructor(message: string) {
    super('remote-environment-conflict', message);
    this.name = 'RemoteEnvironmentConflictError';
  }
}
export class LocalEnvironmentConflictError extends StackCloudError {
  constructor(message: string) {
    super('local-environment-conflict', message);
    this.name = 'LocalEnvironmentConflictError';
  }
}
export class SnapshotUploadFailedError extends StackCloudError {
  constructor(message: string, options?: ErrorOptions) {
    super('snapshot-upload-failed', message, options);
    this.name = 'SnapshotUploadFailedError';
  }
}
export class SnapshotDownloadFailedError extends StackCloudError {
  constructor(message: string, options?: ErrorOptions) {
    super('snapshot-download-failed', message, options);
    this.name = 'SnapshotDownloadFailedError';
  }
}
export class SnapshotIntegrityMismatchError extends StackCloudError {
  constructor(message: string, options?: ErrorOptions) {
    super('snapshot-integrity-mismatch', message, options);
    this.name = 'SnapshotIntegrityMismatchError';
  }
}
export class ReferenceRestoreFailedError extends StackCloudError {
  constructor(message: string, options?: ErrorOptions) {
    super('reference-restore-failed', message, options);
    this.name = 'ReferenceRestoreFailedError';
  }
}
export class CloudBundleInvalidError extends StackCloudError {
  constructor(message: string, options?: ErrorOptions) {
    super('cloud-bundle-invalid', message, options);
    this.name = 'CloudBundleInvalidError';
  }
}
/**
 * STAK Cloud returned a response this CLI version could not parse — e.g. a shape it
 * doesn't recognize. Distinct from `CloudBundleInvalidError` (which is the SERVER
 * rejecting a bundle the CLIENT sent): this is the CLIENT failing to understand what
 * the server sent back. Wraps the underlying parse error (never shown raw to the user)
 * so it is caught by the same bounded, sanitized CLI error path as every other
 * `StackCloudError` instead of propagating as an uncaught exception.
 */
export class CloudResponseInvalidError extends StackCloudError {
  constructor(
    message = 'STAK Cloud returned a response this CLI version could not read.',
    options?: ErrorOptions,
  ) {
    super('cloud-response-invalid', message, options);
    this.name = 'CloudResponseInvalidError';
  }
}
export class CloudVersionCommitFailedError extends StackCloudError {
  constructor(message: string, options?: ErrorOptions) {
    super('cloud-version-commit-failed', message, options);
    this.name = 'CloudVersionCommitFailedError';
  }
}
export class PublicStackNotFoundError extends StackCloudError {
  constructor(message = 'The public Stack does not exist.') {
    super('public-stack-not-found', message);
    this.name = 'PublicStackNotFoundError';
  }
}
export class PublicStackConflictError extends StackCloudError {
  constructor(message: string) {
    super('public-stack-conflict', message);
    this.name = 'PublicStackConflictError';
  }
}
export class PublicationNotEligibleError extends StackCloudError {
  constructor(message: string) {
    super('publication-not-eligible', message);
    this.name = 'PublicationNotEligibleError';
  }
}

/** Map a server error code + status into a typed client error. */
export const cloudErrorFromResponse = (
  status: number,
  code: CloudErrorCode | string | undefined,
  message: string,
): StackCloudError => {
  switch (code) {
    case 'not-authenticated':
      return new NotAuthenticatedError(message);
    case 'authentication-expired':
      return new AuthenticationExpiredError(message);
    case 'cloud-unauthorized':
      return new CloudUnauthorizedError(message);
    case 'remote-environment-not-found':
      return new RemoteEnvironmentNotFoundError(message);
    case 'remote-environment-conflict':
      return new RemoteEnvironmentConflictError(message);
    case 'snapshot-not-found':
      return new SnapshotDownloadFailedError(message);
    case 'snapshot-upload-failed':
      return new SnapshotUploadFailedError(message);
    case 'snapshot-integrity-mismatch':
      return new SnapshotIntegrityMismatchError(message);
    case 'cloud-bundle-invalid':
      return new CloudBundleInvalidError(message);
    case 'cloud-version-commit-failed':
      return new CloudVersionCommitFailedError(message);
    case 'public-stack-not-found':
      return new PublicStackNotFoundError(message);
    case 'public-stack-conflict':
      return new PublicStackConflictError(message);
    case 'publication-not-eligible':
      return new PublicationNotEligibleError(message);
    default:
      if (status === 401) return new NotAuthenticatedError(message);
      if (status === 403) return new CloudUnauthorizedError(message);
      if (code)
        return new StackCloudError(code, message || `Cloud error ${status}`);
      return new StackCloudError(
        'cloud-error',
        message || `Cloud error ${status}`,
      );
  }
};
