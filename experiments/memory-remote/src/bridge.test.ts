import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  BridgeError,
  OneTimeSessionRelay,
  createRecoverySession,
  openMmkFromEnvelope,
  sealMmkForCli,
} from './bridge.js';

const USER = 'user-bridge';

describe('CLI ↔ browser zero-knowledge recovery bridge', () => {
  it('transfers the MMK from browser to CLI end-to-end', async () => {
    const mmk = randomBytes(32);
    const { session, cliPrivateKey } = await createRecoverySession({
      userId: USER,
      ttlMs: 60_000,
    });
    const envelope = await sealMmkForCli({ session, mmk });
    const recovered = await openMmkFromEnvelope({
      session,
      cliPrivateKey,
      envelope,
    });
    expect(recovered.equals(mmk)).toBe(true);
  });

  it('relays only opaque material — the MMK never appears in session or envelope', async () => {
    const mmk = randomBytes(32);
    const relay = new OneTimeSessionRelay();
    const { session } = await createRecoverySession({
      userId: USER,
      ttlMs: 60_000,
    });
    relay.publishSession(session);
    const envelope = await sealMmkForCli({ session, mmk });
    relay.submitEnvelope(envelope);

    const serverView = JSON.stringify({ session, envelope });
    expect(serverView).not.toContain(mmk.toString('base64'));
  });

  it('a different CLI ephemeral key cannot decrypt the envelope', async () => {
    const mmk = randomBytes(32);
    const { session } = await createRecoverySession({
      userId: USER,
      ttlMs: 60_000,
    });
    const envelope = await sealMmkForCli({ session, mmk });
    // Attacker holds the public session but a different private key.
    const other = await createRecoverySession({ userId: USER, ttlMs: 60_000 });
    await expect(
      openMmkFromEnvelope({
        session,
        cliPrivateKey: other.cliPrivateKey,
        envelope,
      }),
    ).rejects.toBeInstanceOf(BridgeError);
  });

  it('rejects an expired recovery session', async () => {
    const mmk = randomBytes(32);
    const { session, cliPrivateKey } = await createRecoverySession({
      userId: USER,
      ttlMs: 1_000,
    });
    const envelope = await sealMmkForCli({ session, mmk });
    await expect(
      openMmkFromEnvelope({
        session,
        cliPrivateKey,
        envelope,
        now: () => new Date(Date.now() + 10_000),
      }),
    ).rejects.toMatchObject({ code: 'expired' });
  });

  it('rejects an envelope for a different session id', async () => {
    const mmk = randomBytes(32);
    const a = await createRecoverySession({ userId: USER, ttlMs: 60_000 });
    const b = await createRecoverySession({ userId: USER, ttlMs: 60_000 });
    const envelopeForB = await sealMmkForCli({ session: b.session, mmk });
    await expect(
      openMmkFromEnvelope({
        session: a.session,
        cliPrivateKey: a.cliPrivateKey,
        envelope: envelopeForB,
      }),
    ).rejects.toMatchObject({ code: 'session-mismatch' });
  });

  it('rejects a tampered envelope', async () => {
    const mmk = randomBytes(32);
    const { session, cliPrivateKey } = await createRecoverySession({
      userId: USER,
      ttlMs: 60_000,
    });
    const envelope = await sealMmkForCli({ session, mmk });
    const bytes = Buffer.from(envelope.ciphertextB64, 'base64');
    const first = bytes[0] ?? 0;
    bytes[0] = first ^ 0xff;
    const tampered = { ...envelope, ciphertextB64: bytes.toString('base64') };
    await expect(
      openMmkFromEnvelope({ session, cliPrivateKey, envelope: tampered }),
    ).rejects.toMatchObject({ code: 'decrypt-failed' });
  });

  it('the one-time relay refuses a replayed consume', async () => {
    const mmk = randomBytes(32);
    const relay = new OneTimeSessionRelay();
    const { session } = await createRecoverySession({
      userId: USER,
      ttlMs: 60_000,
    });
    relay.publishSession(session);
    relay.submitEnvelope(await sealMmkForCli({ session, mmk }));
    expect(relay.consumeEnvelope(session.sessionId)).toBeDefined();
    expect(() => relay.consumeEnvelope(session.sessionId)).toThrowError(
      BridgeError,
    );
  });
});
