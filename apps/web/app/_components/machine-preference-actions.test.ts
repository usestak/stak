import { afterEach, describe, expect, it, vi } from 'vitest';

const setMock = vi.fn();
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ set: setMock })),
}));

import { setActiveMachinePreference } from './machine-preference-actions';
import { ACTIVE_MACHINE_COOKIE } from '../../lib/machine-preference';

afterEach(() => {
  vi.clearAllMocks();
});

describe('setActiveMachinePreference', () => {
  it('persists the chosen machine id under the shared cookie name', async () => {
    await setActiveMachinePreference('machine-abc');
    expect(setMock).toHaveBeenCalledWith(
      ACTIVE_MACHINE_COOKIE,
      'machine-abc',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      }),
    );
  });

  it('never marks the cookie Secure outside production (would break local dev over http)', async () => {
    const previous = process.env.NODE_ENV;
    // @ts-expect-error -- test-only override of a readonly-in-types env var
    process.env.NODE_ENV = 'development';
    await setActiveMachinePreference('machine-abc');
    expect(setMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ secure: false }),
    );
    // @ts-expect-error -- restore
    process.env.NODE_ENV = previous;
  });
});
