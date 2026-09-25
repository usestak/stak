import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { randomKey } from './cipher.js';
import {
  MmkError,
  generateMmk,
  newKeyring,
  removeWrapper,
  unwrapDekWithMmk,
  unwrapWith,
  wrapDekWithMmk,
} from './mmk.js';
import {
  addPasskeyWrapper,
  addRecoveryFileWrapper,
  generateRecoveryKey,
  unwrapWithPasskey,
  unwrapWithRecoveryKey,
} from './recovery-methods.js';

const bytesEqual = (a: Buffer, b: Buffer): boolean => a.equals(b);

describe('MMK keyring with multiple recovery-method wrappers', () => {
  it('lets two passkeys and a recovery file each unwrap the SAME MMK', () => {
    const mmk = generateMmk();
    const prfA = randomBytes(32);
    const prfB = randomBytes(32);
    const recoveryKey = generateRecoveryKey().keyBytes;

    let keyring = newKeyring();
    keyring = addPasskeyWrapper({
      keyring,
      mmk,
      prfOutput: prfA,
      label: 'Passkey A',
    }).keyring;
    keyring = addPasskeyWrapper({
      keyring,
      mmk,
      prfOutput: prfB,
      label: 'Passkey B',
    }).keyring;
    keyring = addRecoveryFileWrapper({ keyring, mmk, recoveryKey }).keyring;

    const [wA, wB, wFile] = keyring.wrappers;
    expect(wA && wB && wFile).toBeTruthy();
    if (!wA || !wB || !wFile) return;

    expect(
      bytesEqual(
        unwrapWithPasskey({ keyring, wrapper: wA, prfOutput: prfA }),
        mmk,
      ),
    ).toBe(true);
    expect(
      bytesEqual(
        unwrapWithPasskey({ keyring, wrapper: wB, prfOutput: prfB }),
        mmk,
      ),
    ).toBe(true);
    expect(
      bytesEqual(
        unwrapWithRecoveryKey({ keyring, wrapper: wFile, recoveryKey }),
        mmk,
      ),
    ).toBe(true);
  });

  it('removing one wrapper does not break the others', () => {
    const mmk = generateMmk();
    const prfA = randomBytes(32);
    const recoveryKey = generateRecoveryKey().keyBytes;
    let keyring = newKeyring();
    const passkey = addPasskeyWrapper({ keyring, mmk, prfOutput: prfA });
    keyring = passkey.keyring;
    keyring = addRecoveryFileWrapper({ keyring, mmk, recoveryKey }).keyring;

    keyring = removeWrapper(keyring, passkey.wrapper.wrapperId);
    expect(keyring.wrappers).toHaveLength(1);
    const remaining = keyring.wrappers[0];
    expect(remaining).toBeDefined();
    if (remaining)
      expect(
        bytesEqual(
          unwrapWithRecoveryKey({ keyring, wrapper: remaining, recoveryKey }),
          mmk,
        ),
      ).toBe(true);
  });

  it('refuses to remove the last wrapper (would orphan the MMK)', () => {
    const mmk = generateMmk();
    let keyring = newKeyring();
    const only = addPasskeyWrapper({
      keyring,
      mmk,
      prfOutput: randomBytes(32),
    });
    keyring = only.keyring;
    expect(() => removeWrapper(keyring, only.wrapper.wrapperId)).toThrowError(
      MmkError,
    );
  });

  it('fails to unwrap with a wrong PRF output', () => {
    const mmk = generateMmk();
    let keyring = newKeyring();
    const added = addPasskeyWrapper({
      keyring,
      mmk,
      prfOutput: randomBytes(32),
    });
    keyring = added.keyring;
    expect(() =>
      unwrapWithPasskey({
        keyring,
        wrapper: added.wrapper,
        prfOutput: randomBytes(32),
      }),
    ).toThrowError(MmkError);
  });

  it('fails to unwrap a tampered wrapper', () => {
    const mmk = generateMmk();
    const prf = randomBytes(32);
    let keyring = newKeyring();
    const added = addPasskeyWrapper({ keyring, mmk, prfOutput: prf });
    keyring = added.keyring;
    const tampered = {
      ...added.wrapper,
      sealed: {
        ...added.wrapper.sealed,
        ciphertextB64: Buffer.from('zzzz').toString('base64'),
      },
    };
    expect(() =>
      unwrapWithPasskey({ keyring, wrapper: tampered, prfOutput: prf }),
    ).toThrowError(MmkError);
  });

  it('wraps and unwraps a per-backup DEK under the MMK', () => {
    const mmk = generateMmk();
    const dek = randomKey();
    const wrapped = wrapDekWithMmk(dek, mmk, 'backup-1');
    expect(bytesEqual(unwrapDekWithMmk(wrapped, mmk, 'backup-1'), dek)).toBe(
      true,
    );
  });

  it('a DEK wrapped for one backup id will not unwrap under another (AAD binding)', () => {
    const mmk = generateMmk();
    const wrapped = wrapDekWithMmk(randomKey(), mmk, 'backup-1');
    expect(() => unwrapDekWithMmk(wrapped, mmk, 'backup-2')).toThrowError(
      MmkError,
    );
  });

  it('a wrong MMK cannot unwrap the DEK', () => {
    const wrapped = wrapDekWithMmk(randomKey(), generateMmk(), 'backup-1');
    expect(() =>
      unwrapDekWithMmk(wrapped, generateMmk(), 'backup-1'),
    ).toThrowError(MmkError);
  });

  it('unwrapWith surfaces a wrong-KEK failure as MmkError', () => {
    const mmk = generateMmk();
    let keyring = newKeyring();
    const added = addPasskeyWrapper({
      keyring,
      mmk,
      prfOutput: randomBytes(32),
    });
    keyring = added.keyring;
    expect(() =>
      unwrapWith({ keyring, wrapper: added.wrapper, kek: randomKey() }),
    ).toThrowError(MmkError);
  });
});
