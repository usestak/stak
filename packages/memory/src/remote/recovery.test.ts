import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { randomKey } from './cipher.js';
import { derivePasskeyKek, deriveRecoveryKek } from './kdf.js';
import {
  MmkError,
  generateMmk,
  newKeyring,
  removeWrapper,
  unwrapDekWithMmk,
  wrapDekWithMmk,
} from './mmk.js';
import {
  RECOVERY_FILE_FORMAT,
  addPasskeyWrapper,
  addRecoveryFileWrapper,
  generateRecoveryKey,
  recoveryKeyFromCode,
  recoveryKeyFromFile,
  unwrapWithPasskey,
  unwrapWithRecoveryKey,
} from './recovery-methods.js';

describe('MMK keyring + multiple recovery methods', () => {
  it('lets two passkeys and a recovery file each unwrap the SAME MMK', () => {
    const mmk = generateMmk();
    const prfA = randomBytes(32);
    const prfB = randomBytes(32);
    const recoveryKey = generateRecoveryKey().keyBytes;
    let keyring = newKeyring();
    keyring = addPasskeyWrapper({ keyring, mmk, prfOutput: prfA }).keyring;
    keyring = addPasskeyWrapper({ keyring, mmk, prfOutput: prfB }).keyring;
    keyring = addRecoveryFileWrapper({ keyring, mmk, recoveryKey }).keyring;
    const [wA, wB, wFile] = keyring.wrappers;
    expect(wA && wB && wFile).toBeTruthy();
    if (!wA || !wB || !wFile) return;
    expect(
      unwrapWithPasskey({ keyring, wrapper: wA, prfOutput: prfA }).equals(mmk),
    ).toBe(true);
    expect(
      unwrapWithPasskey({ keyring, wrapper: wB, prfOutput: prfB }).equals(mmk),
    ).toBe(true);
    expect(
      unwrapWithRecoveryKey({ keyring, wrapper: wFile, recoveryKey }).equals(
        mmk,
      ),
    ).toBe(true);
  });

  it('removing one wrapper leaves the others valid', () => {
    const mmk = generateMmk();
    const prf = randomBytes(32);
    const recoveryKey = generateRecoveryKey().keyBytes;
    let keyring = newKeyring();
    const passkey = addPasskeyWrapper({ keyring, mmk, prfOutput: prf });
    keyring = passkey.keyring;
    keyring = addRecoveryFileWrapper({ keyring, mmk, recoveryKey }).keyring;
    keyring = removeWrapper(keyring, passkey.wrapper.wrapperId);
    expect(keyring.wrappers).toHaveLength(1);
    const remaining = keyring.wrappers[0];
    if (remaining)
      expect(
        unwrapWithRecoveryKey({
          keyring,
          wrapper: remaining,
          recoveryKey,
        }).equals(mmk),
      ).toBe(true);
  });

  it('refuses to remove the last wrapper', () => {
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
    const added = addPasskeyWrapper({
      keyring: newKeyring(),
      mmk,
      prfOutput: randomBytes(32),
    });
    expect(() =>
      unwrapWithPasskey({
        keyring: added.keyring,
        wrapper: added.wrapper,
        prfOutput: randomBytes(32),
      }),
    ).toThrowError(MmkError);
  });

  it('binds a wrapped DEK to its backup id', () => {
    const mmk = generateMmk();
    const wrapped = wrapDekWithMmk(randomKey(), mmk, 'backup-1');
    expect(() => unwrapDekWithMmk(wrapped, mmk, 'backup-2')).toThrowError(
      MmkError,
    );
  });
});

describe('recovery-file fallback', () => {
  it('generates a 256-bit key with matching printable + file forms', () => {
    const artifacts = generateRecoveryKey();
    expect(artifacts.keyBytes).toHaveLength(32);
    expect(artifacts.file.format).toBe(RECOVERY_FILE_FORMAT);
    expect(
      recoveryKeyFromCode(artifacts.printableCode).equals(artifacts.keyBytes),
    ).toBe(true);
    expect(recoveryKeyFromFile(artifacts.file).equals(artifacts.keyBytes)).toBe(
      true,
    );
    expect(artifacts.file.note).toMatch(/not secure by itself/i);
  });

  it('round-trips the MMK through a recovery-file wrapper', () => {
    const mmk = generateMmk();
    const artifacts = generateRecoveryKey();
    const added = addRecoveryFileWrapper({
      keyring: newKeyring(),
      mmk,
      recoveryKey: artifacts.keyBytes,
    });
    const recovered = unwrapWithRecoveryKey({
      keyring: added.keyring,
      wrapper: added.wrapper,
      recoveryKey: recoveryKeyFromFile(artifacts.file),
    });
    expect(recovered.equals(mmk)).toBe(true);
  });

  it('a wrong recovery key cannot unwrap', () => {
    const added = addRecoveryFileWrapper({
      keyring: newKeyring(),
      mmk: generateMmk(),
      recoveryKey: generateRecoveryKey().keyBytes,
    });
    expect(() =>
      unwrapWithRecoveryKey({
        keyring: added.keyring,
        wrapper: added.wrapper,
        recoveryKey: generateRecoveryKey().keyBytes,
      }),
    ).toThrowError(MmkError);
  });
});

describe('KDF domain separation', () => {
  it('passkey and recovery-file derive different KEKs from the same input', () => {
    const ikm = randomBytes(32);
    const salt = randomBytes(16);
    expect(
      derivePasskeyKek(ikm, salt).equals(deriveRecoveryKek(ikm, salt)),
    ).toBe(false);
  });
});
