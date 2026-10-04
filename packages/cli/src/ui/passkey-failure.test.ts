import { describe, expect, it } from 'vitest';

import { renderPasskeyFailure } from './memory.js';

const REASONS = [
  'cancelled',
  'provider-error',
  'unsupported',
  'timed-out',
  'session-expired',
  'error',
] as const;

describe('renderPasskeyFailure (R6)', () => {
  it('#12 recover failures always surface the recovery-file fallback', () => {
    for (const reason of REASONS) {
      const out = renderPasskeyFailure('recover', reason);
      expect(out).toContain('stak memory recover --recovery-file');
    }
  });

  it('protect failures point to retry or a recovery file (never Standard)', () => {
    for (const reason of REASONS) {
      const out = renderPasskeyFailure('protect', reason);
      expect(out.toLowerCase()).not.toContain('standard');
      // Either retry the passkey or use a recovery file is offered.
      expect(/recovery file|--passkey|recover/i.test(out)).toBe(true);
    }
  });

  it('never claims Memory is corrupted or invalid', () => {
    for (const mode of ['recover', 'protect'] as const)
      for (const reason of REASONS) {
        const out = renderPasskeyFailure(mode, reason).toLowerCase();
        expect(out).not.toContain('corrupt');
        expect(out).not.toContain('invalid');
      }
  });

  it('cancellation reads as a clean, retryable abort', () => {
    expect(
      renderPasskeyFailure('recover', 'cancelled').toLowerCase(),
    ).toContain('cancelled');
  });

  it('#14 contains no PRF/MMK/DEK/recovery-key material', () => {
    for (const mode of ['recover', 'protect'] as const)
      for (const reason of REASONS) {
        const out = renderPasskeyFailure(mode, reason).toLowerCase();
        for (const secret of ['mmk', 'prf', 'dek', 'recovery-key'])
          expect(out).not.toContain(secret);
      }
  });
});
