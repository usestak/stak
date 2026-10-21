import { describe, expect, it } from 'vitest';

import { productEventToRow } from './cloud-service';

describe('productEventToRow', () => {
  it('maps every ProductEvent field onto its product_events column name', () => {
    const row = productEventToRow({
      userId: 'user-1',
      eventName: 'cloud.push.succeeded',
      machineId: 'machine-1',
      success: true,
      errorCode: 'some-error',
      metadata: { environmentId: 'env-1' },
    });
    expect(row).toEqual({
      user_id: 'user-1',
      event_name: 'cloud.push.succeeded',
      machine_id: 'machine-1',
      success: true,
      error_code: 'some-error',
      metadata: { environmentId: 'env-1' },
    });
  });

  it('coalesces absent optional fields to null rather than undefined', () => {
    const row = productEventToRow({
      userId: null,
      eventName: 'cloud.pull.succeeded',
      success: true,
    });
    expect(row).toEqual({
      user_id: null,
      event_name: 'cloud.pull.succeeded',
      machine_id: null,
      success: true,
      error_code: null,
      metadata: null,
    });
  });
});
