import { describe, expect, it } from 'vitest';
import {
  TryAuthBridgeFailedError,
  TryRuntimeCleanupFailedError,
} from './errors.js';

describe('multi-agent trial error wording', () => {
  it('names the requesting agent in TryRuntimeCleanupFailedError, not Codex', () => {
    expect(new TryRuntimeCleanupFailedError('Claude').message).toContain(
      'Claude',
    );
    expect(new TryRuntimeCleanupFailedError('Claude').message).not.toContain(
      'Codex',
    );
    expect(new TryRuntimeCleanupFailedError('Cursor').message).toContain(
      'Cursor',
    );
    expect(new TryRuntimeCleanupFailedError('Cursor').message).not.toContain(
      'Codex',
    );
  });

  it('names the requesting agent in TryAuthBridgeFailedError, not Codex', () => {
    expect(new TryAuthBridgeFailedError('Claude').message).toContain(
      'Claude',
    );
    expect(new TryAuthBridgeFailedError('Claude').message).not.toContain(
      'Codex',
    );
    expect(new TryAuthBridgeFailedError('Cursor').message).toContain(
      'Cursor',
    );
    expect(new TryAuthBridgeFailedError('Cursor').message).not.toContain(
      'Codex',
    );
  });

  it('defaults to Codex wording when no agent is supplied', () => {
    expect(new TryRuntimeCleanupFailedError().message).toContain('Codex');
    expect(new TryAuthBridgeFailedError().message).toContain('Codex');
  });
});
