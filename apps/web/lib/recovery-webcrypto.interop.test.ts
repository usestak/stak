import { randomBytes } from 'node:crypto';

import {
  addPasskeyWrapper,
  createRecoverySession,
  generateMmk,
  newKeyring,
  openMmkFromEnvelope,
  unwrapWithPasskey,
} from '@stack/memory';
import { describe, expect, it } from 'vitest';

import {
  sealMmkForCli,
  unwrapMmkWithPrf,
  wrapMmkWithPrf,
  type StoredMmkWrapper,
} from './recovery-webcrypto';

const bytesEqual = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a).equals(Buffer.from(b));

/**
 * Proves the browser Web Crypto module and the Node/CLI @stack/memory domain are
 * the SAME construction (interoperable), not two divergent implementations.
 */
describe('web ↔ domain crypto interop', () => {
  it('browser unwraps a passkey wrapper the domain created', async () => {
    const mmk = generateMmk();
    const prf = randomBytes(32);
    const added = addPasskeyWrapper({
      keyring: newKeyring(),
      mmk,
      prfOutput: prf,
    });
    const stored: StoredMmkWrapper = {
      mmkId: added.keyring.mmkId,
      wrapper: added.wrapper as StoredMmkWrapper['wrapper'],
    };
    const recovered = await unwrapMmkWithPrf({ stored, prfOutput: prf });
    expect(bytesEqual(recovered, mmk)).toBe(true);
  });

  it('domain unwraps a passkey wrapper the browser created', async () => {
    const mmk = randomBytes(32);
    const prf = randomBytes(32);
    const stored = await wrapMmkWithPrf({
      mmk,
      prfOutput: prf,
      label: 'Passkey',
    });
    const keyring = { mmkId: stored.mmkId, wrappers: [stored.wrapper] };
    const recovered = unwrapWithPasskey({
      keyring,
      wrapper: stored.wrapper,
      prfOutput: prf,
    });
    expect(bytesEqual(recovered, mmk)).toBe(true);
  });

  it('a wrong PRF output cannot unwrap the browser-created wrapper (domain side)', async () => {
    const stored = await wrapMmkWithPrf({
      mmk: randomBytes(32),
      prfOutput: randomBytes(32),
      label: 'Passkey',
    });
    const keyring = { mmkId: stored.mmkId, wrappers: [stored.wrapper] };
    expect(() =>
      unwrapWithPasskey({
        keyring,
        wrapper: stored.wrapper,
        prfOutput: randomBytes(32),
      }),
    ).toThrow();
  });

  it('the CLI (domain) opens an MMK the browser sealed over the bridge', async () => {
    const mmk = randomBytes(32);
    const { session, initiatorPrivateKey } = await createRecoverySession({
      userId: 'user-1',
      ttlMs: 60_000,
      direction: 'recovery',
    });
    const envelope = await sealMmkForCli({ session, mmk });
    const recovered = await openMmkFromEnvelope({
      session,
      initiatorPrivateKey,
      envelope: { ...envelope, version: 'stack-mem-bridge-v1' as const },
    });
    expect(bytesEqual(recovered, mmk)).toBe(true);
  });

  it('a tampered bridge envelope fails to open (domain side)', async () => {
    const mmk = randomBytes(32);
    const { session, initiatorPrivateKey } = await createRecoverySession({
      userId: 'user-1',
      ttlMs: 60_000,
      direction: 'recovery',
    });
    const envelope = await sealMmkForCli({ session, mmk });
    const bytes = Buffer.from(envelope.ciphertextB64, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    await expect(
      openMmkFromEnvelope({
        session,
        initiatorPrivateKey,
        envelope: {
          ...envelope,
          version: 'stack-mem-bridge-v1' as const,
          ciphertextB64: bytes.toString('base64'),
        },
      }),
    ).rejects.toThrow();
  });
});
