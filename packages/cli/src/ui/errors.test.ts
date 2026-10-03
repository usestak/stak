import { describe, expect, it } from 'vitest';

import {
  AuthenticationExpiredError,
  RemoteEnvironmentConflictError,
  StackCloudError,
} from '@stack/cloud-client';

import { formatCliError } from './errors.js';

describe('formatCliError', () => {
  it('turns a generic cloud failure into a calm, actionable message', () => {
    const message = formatCliError(
      new StackCloudError('cloud-error', 'Cloud error 500'),
    );
    expect(message).toContain('STAK Cloud could not complete the request.');
    expect(message).toContain('--verbose');
    // The raw HTTP/status detail is hidden by default.
    expect(message).not.toContain('500');
  });

  it('reveals underlying details for a generic cloud failure under --verbose', () => {
    const message = formatCliError(
      new StackCloudError('cloud-error', 'Cloud error 500'),
      { verbose: true },
    );
    expect(message).toContain('STAK Cloud could not complete the request.');
    expect(message).toContain('Cloud error 500');
  });

  it('keeps actionable auth errors verbatim', () => {
    const message = formatCliError(new AuthenticationExpiredError());
    expect(message).toContain('Run stak login again.');
  });

  it('keeps synchronization conflict errors verbatim', () => {
    const message = formatCliError(
      new RemoteEnvironmentConflictError(
        'Cloud main changed since this Machine last synced.',
      ),
    );
    expect(message).toContain('changed since this Machine last synced');
  });

  it('passes through non-cloud error messages', () => {
    const message = formatCliError(new Error('main does not exist.'));
    expect(message).toBe('main does not exist.');
  });
});
