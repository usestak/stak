import { describe, expect, it, vi } from 'vitest';

import {
  loadPendingCliAuthSession,
  type CliAuthQueryService,
} from './queries.js';

const fakeService = (
  result: Awaited<ReturnType<CliAuthQueryService['getPendingCliAuthSession']>>,
): CliAuthQueryService => ({
  getPendingCliAuthSession: vi.fn().mockResolvedValue(result),
});

describe('loadPendingCliAuthSession', () => {
  it('passes the real pending session (with a label) straight through', async () => {
    const service = fakeService({
      status: 'pending',
      label: 'temi-laptop',
      expiresAt: '2026-01-01T00:10:00.000Z',
    });
    await expect(
      loadPendingCliAuthSession(service, 'ABCD-1234'),
    ).resolves.toEqual({
      status: 'pending',
      label: 'temi-laptop',
      expiresAt: '2026-01-01T00:10:00.000Z',
    });
    expect(service.getPendingCliAuthSession).toHaveBeenCalledWith('ABCD-1234');
  });

  it('passes a pending session without a label straight through', async () => {
    const service = fakeService({
      status: 'pending',
      expiresAt: '2026-01-01T00:10:00.000Z',
    });
    const view = await loadPendingCliAuthSession(service, 'ABCD-1234');
    expect(view).not.toBeNull();
    expect(view).not.toHaveProperty('label');
  });

  it('passes an expired session straight through', async () => {
    const service = fakeService({
      status: 'expired',
      expiresAt: '2026-01-01T00:10:00.000Z',
    });
    await expect(
      loadPendingCliAuthSession(service, 'ABCD-1234'),
    ).resolves.toMatchObject({ status: 'expired' });
  });

  it('passes an already-consumed session straight through', async () => {
    const service = fakeService({
      status: 'consumed',
      expiresAt: '2026-01-01T00:10:00.000Z',
    });
    await expect(
      loadPendingCliAuthSession(service, 'ABCD-1234'),
    ).resolves.toMatchObject({ status: 'consumed' });
  });

  it('passes null through for an unknown code', async () => {
    const service = fakeService(null);
    await expect(
      loadPendingCliAuthSession(service, 'NOPE-NOPE'),
    ).resolves.toBeNull();
  });
});
