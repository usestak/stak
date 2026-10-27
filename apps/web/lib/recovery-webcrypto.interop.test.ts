import { randomBytes } from 'node:crypto';

import {
  addPasskeyWrapper,
  createRecoverySession,
  generateMmk,
  newKeyring,
  openMmkFromEnvelope,
  unwrapWithPasskey,
  wrapDekWithMmk,
} from '@stack/memory';
import { describe, expect, it } from 'vitest';

import {
  mmkOpensWrappedDek,
  selectPasskeyMmk,
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

describe('final review I7: passkey recovery verifies the unwrapped key and tries every wrapper', () => {
  const storedFor = (mmk: Buffer, prf: Buffer): StoredMmkWrapper => {
    const added = addPasskeyWrapper({
      keyring: newKeyring(),
      mmk,
      prfOutput: prf,
    });
    return {
      mmkId: added.keyring.mmkId,
      wrapper: added.wrapper as StoredMmkWrapper['wrapper'],
    };
  };

  it('mmkOpensWrappedDek matches the domain DEK wrap (right key true, wrong key or wrong backup false)', async () => {
    const mmk = generateMmk();
    const check = {
      backupId: 'b-1',
      wrappedDek: wrapDekWithMmk(randomBytes(32), mmk, 'b-1'),
    };
    expect(await mmkOpensWrappedDek({ mmk, check })).toBe(true);
    expect(await mmkOpensWrappedDek({ mmk: generateMmk(), check })).toBe(false);
    expect(
      await mmkOpensWrappedDek({ mmk, check: { ...check, backupId: 'b-2' } }),
    ).toBe(false);
  });

  it('a leftover wrapper (an abandoned protect key, listed FIRST, same passkey) is skipped; the verified key is chosen, with one passkey prompt', async () => {
    const prf = randomBytes(32);
    const leftover = generateMmk();
    const real = generateMmk();
    const check = {
      backupId: 'b-9',
      wrappedDek: wrapDekWithMmk(randomBytes(32), real, 'b-9'),
    };
    let prompts = 0;
    const result = await selectPasskeyMmk({
      wrappers: [
        { publicIdentifier: 'cred-1', mmkWrapper: storedFor(leftover, prf) },
        { publicIdentifier: 'cred-1', mmkWrapper: storedFor(real, prf) },
      ],
      getPrf: async () => {
        prompts += 1;
        return new Uint8Array(prf);
      },
      check,
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(bytesEqual(result.mmk, real)).toBe(true);
    expect(prompts).toBe(1);
  });

  it('a passkey without PRF does not stop the search; only no PRF at all reports no-prf; nothing verifiable reports no-match', async () => {
    const prf = randomBytes(32);
    const real = generateMmk();
    const check = {
      backupId: 'b-3',
      wrappedDek: wrapDekWithMmk(randomBytes(32), real, 'b-3'),
    };
    const wrappers = [
      {
        publicIdentifier: 'cred-no-prf',
        mmkWrapper: storedFor(generateMmk(), randomBytes(32)),
      },
      { publicIdentifier: 'cred-2', mmkWrapper: storedFor(real, prf) },
    ];
    const ok = await selectPasskeyMmk({
      wrappers,
      getPrf: async (id) => (id === 'cred-2' ? new Uint8Array(prf) : null),
      check,
    });
    expect(ok.status).toBe('ok');
    expect(
      (await selectPasskeyMmk({ wrappers, getPrf: async () => null, check }))
        .status,
    ).toBe('no-prf');
    const leftoverOnly = [
      { publicIdentifier: 'cred-2', mmkWrapper: storedFor(generateMmk(), prf) },
    ];
    expect(
      (
        await selectPasskeyMmk({
          wrappers: leftoverOnly,
          getPrf: async () => new Uint8Array(prf),
          check,
        })
      ).status,
    ).toBe('no-match');
  });

  it('with no Protected generation to check against, the first key that unwraps is used (unchanged behaviour)', async () => {
    const prf = randomBytes(32);
    const mmk = generateMmk();
    const result = await selectPasskeyMmk({
      wrappers: [
        { publicIdentifier: 'cred-1', mmkWrapper: storedFor(mmk, prf) },
      ],
      getPrf: async () => new Uint8Array(prf),
      check: null,
    });
    expect(result.status === 'ok' && bytesEqual(result.mmk, mmk)).toBe(true);
  });
});
