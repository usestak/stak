import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { derivePasskeyKek, deriveRecoveryKek } from './kdf.js';
import { generateMmk, newKeyring } from './mmk.js';
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

describe('recovery key artifacts (fallback recovery method)', () => {
  it('generates a 256-bit key with matching printable code and file forms', () => {
    const artifacts = generateRecoveryKey();
    expect(artifacts.keyBytes).toHaveLength(32);
    expect(artifacts.file.format).toBe(RECOVERY_FILE_FORMAT);
    // Both exported forms decode back to the same secret.
    expect(
      recoveryKeyFromCode(artifacts.printableCode).equals(artifacts.keyBytes),
    ).toBe(true);
    expect(recoveryKeyFromFile(artifacts.file).equals(artifacts.keyBytes)).toBe(
      true,
    );
    // The file is honest about not being secure by itself.
    expect(artifacts.file.note).toMatch(/not secure by itself/i);
  });

  it('round-trips the MMK through a recovery-file wrapper (from the file)', () => {
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
});

describe('passkey PRF crypto (given a PRF output; does NOT prove PRF availability)', () => {
  // NOTE: these tests prove the wrapping crypto GIVEN a 32-byte PRF output. They do
  // NOT prove that a real browser/authenticator produces PRF output — that is the
  // job of the manual dogfood page (dogfood/) and is documented as unproven here.

  it('derives a stable KEK from the same PRF output + salt (determinism model)', () => {
    const prf = randomBytes(32);
    const salt = randomBytes(16);
    expect(
      derivePasskeyKek(prf, salt).equals(derivePasskeyKek(prf, salt)),
    ).toBe(true);
  });

  it('different PRF outputs derive different KEKs', () => {
    const salt = randomBytes(16);
    expect(
      derivePasskeyKek(randomBytes(32), salt).equals(
        derivePasskeyKek(randomBytes(32), salt),
      ),
    ).toBe(false);
  });

  it('passkey and recovery-file paths use different HKDF domains', () => {
    const ikm = randomBytes(32);
    const salt = randomBytes(16);
    // Same input material, different domain label → different keys (no cross-use).
    expect(
      derivePasskeyKek(ikm, salt).equals(deriveRecoveryKek(ikm, salt)),
    ).toBe(false);
  });

  it('wraps and recovers the MMK across two separate PRF authentications', () => {
    const mmk = generateMmk();
    const prf = randomBytes(32); // models "same authenticator + same salt → same output"
    const added = addPasskeyWrapper({
      keyring: newKeyring(),
      mmk,
      prfOutput: prf,
    });
    // Second authentication yields the same PRF output → recovers the same MMK.
    const recovered = unwrapWithPasskey({
      keyring: added.keyring,
      wrapper: added.wrapper,
      prfOutput: prf,
    });
    expect(recovered.equals(mmk)).toBe(true);
  });

  it('a wrong PRF output (e.g. a different authenticator) cannot recover the MMK', () => {
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
    ).toThrow();
  });
});
