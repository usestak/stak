import { afterEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: getMock })),
}));

import {
  ACTIVE_MACHINE_COOKIE,
  readActiveMachinePreference,
} from './machine-preference';

afterEach(() => {
  vi.clearAllMocks();
});

describe('readActiveMachinePreference', () => {
  it('returns the cookie value when present', async () => {
    getMock.mockReturnValue({ value: 'machine-123' });
    await expect(readActiveMachinePreference()).resolves.toBe('machine-123');
    expect(getMock).toHaveBeenCalledWith(ACTIVE_MACHINE_COOKIE);
  });

  it('returns undefined when the cookie was never set', async () => {
    getMock.mockReturnValue(undefined);
    await expect(readActiveMachinePreference()).resolves.toBeUndefined();
  });
});
