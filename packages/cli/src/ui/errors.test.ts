import { describe, expect, it } from 'vitest';

import {
  AuthenticationExpiredError,
  CloudUnavailableError,
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

  // Release-gate finding (2026-10-15): CloudUnavailableError is the exact error a
  // fresh `stak login` throws when the Cloud base URL is unreachable — the
  // real-world trigger for the "...run the command again with --verbose" advice.
  // Prove --verbose never surfaces anything secret-shaped: formatCliError only
  // ever echoes the error's own `.message` verbatim, which the Cloud client never
  // populates with credential material (confirmed in packages/cloud-client/src/
  // client.ts — request() builds an Authorization header but never includes it,
  // a device secret, a login ticket, or a cookie in any thrown error's message).
  it('a real CloudUnavailableError under --verbose never exposes secret-shaped content', () => {
    const message = formatCliError(new CloudUnavailableError(), {
      verbose: true,
    });
    const forbidden = [
      /bearer\s+\S+/i,
      /authorization:/i,
      /device.?secret/i,
      /deviceSecret/i,
      /cookie/i,
      /STAK_TICKET_SECRET/i,
      /service.?role/i,
      /eyJ[a-zA-Z0-9_-]{10,}/, // a JWT-shaped token
    ];
    for (const pattern of forbidden) expect(message).not.toMatch(pattern);
    expect(message).toContain('STAK Cloud could not complete the request.');
  });
});
