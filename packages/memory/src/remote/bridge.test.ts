import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  BridgeError,
  createRecoverySession,
  openMmkFromEnvelope,
  sealMmkForPeer,
} from './bridge.js';

const USER = 'user-bridge';

describe('CLI ↔ browser zero-knowledge bridge', () => {
  it('transfers the MMK end-to-end (browser → CLI recovery)', async () => {
    const mmk = randomBytes(32);
    const { session, initiatorPrivateKey } = await createRecoverySession({
      userId: USER,
      ttlMs: 60_000,
    });
    const envelope = await sealMmkForPeer({ session, mmk });
    const recovered = await openMmkFromEnvelope({
      session,
      initiatorPrivateKey,
      envelope,
    });
    expect(recovered.equals(mmk)).toBe(true);
  });

  it('supports the enrollment direction (CLI → browser)', async () => {
    const mmk = randomBytes(32);
    const { session, initiatorPrivateKey } = await createRecoverySession({
      userId: USER,
      ttlMs: 60_000,
      direction: 'enrollment',
    });
    const envelope = await sealMmkForPeer({ session, mmk });
    const recovered = await openMmkFromEnvelope({
      session,
      initiatorPrivateKey,
      envelope,
    });
    expect(recovered.equals(mmk)).toBe(true);
  });

  it('relays only opaque material — MMK never appears in session or envelope', async () => {
    const mmk = randomBytes(32);
    const { session } = await createRecoverySession({
      userId: USER,
      ttlMs: 60_000,
    });
    const envelope = await sealMmkForPeer({ session, mmk });
    expect(JSON.stringify({ session, envelope })).not.toContain(
      mmk.toString('base64'),
    );
  });

  it('a different initiator key cannot decrypt', async () => {
    const mmk = randomBytes(32);
    const { session } = await createRecoverySession({
      userId: USER,
      ttlMs: 60_000,
    });
    const envelope = await sealMmkForPeer({ session, mmk });
    const other = await createRecoverySession({ userId: USER, ttlMs: 60_000 });
    await expect(
      openMmkFromEnvelope({
        session,
        initiatorPrivateKey: other.initiatorPrivateKey,
        envelope,
      }),
    ).rejects.toBeInstanceOf(BridgeError);
  });

  it('rejects an expired session', async () => {
    const mmk = randomBytes(32);
    const { session, initiatorPrivateKey } = await createRecoverySession({
      userId: USER,
      ttlMs: 1_000,
    });
    const envelope = await sealMmkForPeer({ session, mmk });
    await expect(
      openMmkFromEnvelope({
        session,
        initiatorPrivateKey,
        envelope,
        now: () => new Date(Date.now() + 10_000),
      }),
    ).rejects.toMatchObject({ code: 'expired' });
  });

  it('rejects an envelope for a different session id', async () => {
    const mmk = randomBytes(32);
    const a = await createRecoverySession({ userId: USER, ttlMs: 60_000 });
    const b = await createRecoverySession({ userId: USER, ttlMs: 60_000 });
    const envelopeForB = await sealMmkForPeer({ session: b.session, mmk });
    await expect(
      openMmkFromEnvelope({
        session: a.session,
        initiatorPrivateKey: a.initiatorPrivateKey,
        envelope: envelopeForB,
      }),
    ).rejects.toMatchObject({ code: 'session-mismatch' });
  });

  it('rejects a tampered envelope', async () => {
    const mmk = randomBytes(32);
    const { session, initiatorPrivateKey } = await createRecoverySession({
      userId: USER,
      ttlMs: 60_000,
    });
    const envelope = await sealMmkForPeer({ session, mmk });
    const bytes = Buffer.from(envelope.ciphertextB64, 'base64');
    const first = bytes[0] ?? 0;
    bytes[0] = first ^ 0xff;
    await expect(
      openMmkFromEnvelope({
        session,
        initiatorPrivateKey,
        envelope: { ...envelope, ciphertextB64: bytes.toString('base64') },
      }),
    ).rejects.toMatchObject({ code: 'decrypt-failed' });
  });
});
