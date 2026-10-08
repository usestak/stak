import { describe, expect, it } from 'vitest';

import { resolveCallbackTarget } from './resolve-callback-target.js';

describe('resolveCallbackTarget', () => {
  it('sends a missing code to the error page', () => {
    expect(
      resolveCallbackTarget({
        code: null,
        next: '/overview',
        exchangeFailed: false,
      }),
    ).toBe('/auth/error?reason=missing-code');
  });

  it('sends a failed exchange to the error page, never the requested next', () => {
    expect(
      resolveCallbackTarget({
        code: 'abc',
        next: '/overview',
        exchangeFailed: true,
      }),
    ).toBe('/auth/error?reason=exchange-failed');
  });

  it('honors next on a successful exchange', () => {
    expect(
      resolveCallbackTarget({
        code: 'abc',
        next: '/overview',
        exchangeFailed: false,
      }),
    ).toBe('/overview');
  });
});
