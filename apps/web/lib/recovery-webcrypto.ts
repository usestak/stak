/**
 * Browser-side recovery crypto (Web Crypto only — client-safe; no Node imports).
 *
 * This is the SAME construction as the @stack/memory domain (HKDF-SHA-256 with the
 * same domain labels, AES-256-GCM with the same AAD binding, ECDH P-256 bridge),
 * expressed with the Web Crypto API so it runs in the browser. It is NOT a second
 * design: an interop test (recovery-webcrypto.interop.test.ts) proves envelopes it
 * produces are decrypted by the Node domain and vice-versa.
 *
 * The browser is the bridge PEER: it produces the MMK (by generating it during
 * enrollment, or unwrapping it via passkey PRF during recovery) and seals it to the
 * CLI's ephemeral public key. The CLI (@stack/memory bridge, initiator) decrypts it.
 * The server only ever relays the opaque session + envelope.
 *
 * Secrets (PRF output, MMK, KEK) live only in local variables here and are never
 * returned to the DOM, logged, or sent anywhere except as ciphertext.
 */

/**
 * A terminal, non-cryptographic failure signal (Phase R6). When the passkey ceremony
 * cannot complete, the browser relays this through the SAME opaque one-time envelope so
 * the waiting CLI stops immediately instead of waiting out the session timeout. It
 * carries no key material and does not touch the crypto bridge format. Mirrors
 * `bridgeFailure`/`asBridgeFailure` in @stack/memory.
 */
export type BridgeFailureReason =
  'cancelled' | 'provider-error' | 'unsupported' | 'error';
export const bridgeFailure = (
  reason: BridgeFailureReason,
): { outcome: 'error'; reason: BridgeFailureReason } => ({
  outcome: 'error',
  reason,
});

// Must match @stack/memory: kdf.ts labels, bridge.ts version/AAD, mmk.ts AAD.
const PASSKEY_KDF_INFO = 'stack-memory-passkey-v1';
const BRIDGE_KDF_INFO = 'stack-memory-bridge-v1';
const BRIDGE_VERSION = 'stack-mem-bridge-v1';
// Stable PRF input salt (same value the CLI/domain expects for a passkey wrapper).
const PRF_INPUT_SALT = new TextEncoder().encode(
  'stack-memory-recovery-prf-input-v1',
);

const enc = new TextEncoder();

const toB64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const fromB64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};
const toB64url = (bytes: Uint8Array): string =>
  toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (value: string): Uint8Array =>
  fromB64(value.replace(/-/g, '+').replace(/_/g, '/'));

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

/** Copy into an ArrayBuffer-backed view so Web Crypto's BufferSource types accept it. */
const bs = (x: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(x.byteLength);
  copy.set(x);
  return copy;
};

/* -------------------------------------------------------------------------- */
/* Capability detection (three distinct states; PRF result is ground truth)   */
/* -------------------------------------------------------------------------- */

export type PasskeyCapabilities = {
  passkeySupported: boolean;
  platformAuthenticator: boolean;
  prfAdvertised: boolean;
};

export const detectCapabilities = async (): Promise<PasskeyCapabilities> => {
  const pk = (globalThis as any).PublicKeyCredential;
  const passkeySupported = typeof pk === 'function';
  let platformAuthenticator = false;
  let prfAdvertised = false;
  if (passkeySupported) {
    try {
      platformAuthenticator =
        await pk.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      platformAuthenticator = false;
    }
    try {
      if (typeof pk.getClientCapabilities === 'function') {
        const caps = await pk.getClientCapabilities();
        prfAdvertised = caps?.['extension:prf'] === true;
      }
    } catch {
      prfAdvertised = false;
    }
  }
  return { passkeySupported, platformAuthenticator, prfAdvertised };
};

/* -------------------------------------------------------------------------- */
/* WebAuthn PRF ceremony (browser-only; not exercised by the Node interop test) */
/* -------------------------------------------------------------------------- */

/** Create a passkey with PRF enabled. Returns its raw credential id. */
export const createPasskeyCredential = async (options: {
  rpId: string;
  rpName: string;
  userName: string;
}): Promise<{ credentialId: Uint8Array; prfEnabled: boolean }> => {
  const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const userId = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cred: any = await navigator.credentials.create({
    publicKey: {
      rp: { name: options.rpName, id: options.rpId },
      user: {
        id: userId,
        name: options.userName,
        displayName: options.userName,
      },
      challenge,
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        userVerification: 'required',
        residentKey: 'preferred',
      },
      extensions: { prf: {} },
    },
  });
  if (!cred) throw new Error('Passkey creation was cancelled.');
  const ext = cred.getClientExtensionResults?.();
  return {
    credentialId: new Uint8Array(cred.rawId),
    prfEnabled: ext?.prf?.enabled === true,
  };
};

/**
 * Obtain the 32-byte PRF output via authentication (the reliable path). Returns
 * null when the authenticator/browser did not actually produce PRF output — the
 * ground-truth signal to fall back to a recovery file.
 */
export const getPrfOutput = async (options: {
  rpId: string;
  credentialId: Uint8Array;
}): Promise<Uint8Array | null> => {
  const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const assertion: any = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: options.rpId,
      allowCredentials: [{ type: 'public-key', id: bs(options.credentialId) }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: bs(PRF_INPUT_SALT) } } },
    },
  });
  const first = assertion?.getClientExtensionResults?.()?.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
};

/* -------------------------------------------------------------------------- */
/* Passkey MMK wrapping (matches @stack/memory mmk.ts + kdf.ts)               */
/* -------------------------------------------------------------------------- */

export type StoredMmkWrapper = {
  mmkId: string;
  wrapper: {
    wrapperId: string;
    methodType: 'passkey';
    label: string;
    kdf: { name: 'hkdf-sha256'; saltB64: string; info: string };
    sealed: { nonceB64: string; ciphertextB64: string; tagB64: string };
  };
};

const derivePasskeyKek = async (
  prfOutput: Uint8Array,
  salt: Uint8Array,
): Promise<CryptoKey> => {
  const hkdfKey = await subtle().importKey(
    'raw',
    bs(prfOutput),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await subtle().deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: bs(salt),
      info: bs(enc.encode(PASSKEY_KDF_INFO)),
    },
    hkdfKey,
    256,
  );
  return subtle().importKey('raw', bits, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
};

const wrapperAad = (mmkId: string, wrapperId: string): Uint8Array =>
  enc.encode(JSON.stringify({ mmkId, wrapperId, methodType: 'passkey' }));

/** Wrap a freshly-generated MMK under the passkey PRF (enrollment). */
export const wrapMmkWithPrf = async (options: {
  mmk: Uint8Array;
  prfOutput: Uint8Array;
  label: string;
}): Promise<StoredMmkWrapper> => {
  const mmkId = globalThis.crypto.randomUUID();
  const wrapperId = globalThis.crypto.randomUUID();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const kek = await derivePasskeyKek(options.prfOutput, salt);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(
    await subtle().encrypt(
      {
        name: 'AES-GCM',
        iv: bs(nonce),
        additionalData: bs(wrapperAad(mmkId, wrapperId)),
      },
      kek,
      bs(options.mmk),
    ),
  );
  const ciphertext = out.slice(0, out.length - 16);
  const tag = out.slice(out.length - 16);
  return {
    mmkId,
    wrapper: {
      wrapperId,
      methodType: 'passkey',
      label: options.label,
      kdf: {
        name: 'hkdf-sha256',
        saltB64: toB64(salt),
        info: PASSKEY_KDF_INFO,
      },
      sealed: {
        nonceB64: toB64(nonce),
        ciphertextB64: toB64(ciphertext),
        tagB64: toB64(tag),
      },
    },
  };
};

/** Unwrap the MMK from a stored passkey wrapper using the PRF output (recovery). */
export const unwrapMmkWithPrf = async (options: {
  stored: StoredMmkWrapper;
  prfOutput: Uint8Array;
}): Promise<Uint8Array> => {
  const { mmkId, wrapper } = options.stored;
  const salt = fromB64(wrapper.kdf.saltB64);
  const kek = await derivePasskeyKek(options.prfOutput, salt);
  const nonce = fromB64(wrapper.sealed.nonceB64);
  const combined = new Uint8Array([
    ...fromB64(wrapper.sealed.ciphertextB64),
    ...fromB64(wrapper.sealed.tagB64),
  ]);
  const plaintext = await subtle().decrypt(
    {
      name: 'AES-GCM',
      iv: bs(nonce),
      additionalData: bs(wrapperAad(mmkId, wrapper.wrapperId)),
    },
    kek,
    bs(combined),
  );
  return new Uint8Array(plaintext);
};

/* -------------------------------------------------------------------------- */
/* Bridge: seal the MMK to the CLI's ephemeral public key (matches bridge.ts) */
/* -------------------------------------------------------------------------- */

export type BridgeSessionPublic = {
  sessionId: string;
  userId: string;
  version: string;
  direction: 'recovery' | 'enrollment';
  initiatorPublicKeyB64: string;
  expiresAt: string;
};

export type BridgeEnvelope = {
  sessionId: string;
  version: string;
  peerPublicKeyB64: string;
  nonceB64: string;
  ciphertextB64: string;
};

const bridgeAad = (options: {
  session: BridgeSessionPublic;
  peerPublicKeyB64: string;
}): Uint8Array =>
  enc.encode(
    JSON.stringify({
      v: BRIDGE_VERSION,
      sessionId: options.session.sessionId,
      userId: options.session.userId,
      direction: options.session.direction,
      expiresAt: options.session.expiresAt,
      initiator: options.session.initiatorPublicKeyB64,
      peer: options.peerPublicKeyB64,
    }),
  );

export const sealMmkForCli = async (options: {
  session: BridgeSessionPublic;
  mmk: Uint8Array;
}): Promise<BridgeEnvelope> => {
  const initiatorPublic = await subtle().importKey(
    'raw',
    bs(fromB64(options.session.initiatorPublicKeyB64)),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const pair = await subtle().generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const peerPublicKeyB64 = toB64(
    new Uint8Array(await subtle().exportKey('raw', pair.publicKey)),
  );
  const shared = await subtle().deriveBits(
    { name: 'ECDH', public: initiatorPublic },
    pair.privateKey,
    256,
  );
  const hkdfKey = await subtle().importKey('raw', shared, 'HKDF', false, [
    'deriveBits',
  ]);
  const transferBits = await subtle().deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: bs(enc.encode(options.session.sessionId)),
      info: bs(enc.encode(BRIDGE_KDF_INFO)),
    },
    hkdfKey,
    256,
  );
  const transferKey = await subtle().importKey(
    'raw',
    transferBits,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle().encrypt(
    {
      name: 'AES-GCM',
      iv: bs(nonce),
      additionalData: bs(
        bridgeAad({ session: options.session, peerPublicKeyB64 }),
      ),
    },
    transferKey,
    bs(options.mmk),
  );
  return {
    sessionId: options.session.sessionId,
    version: BRIDGE_VERSION,
    peerPublicKeyB64,
    nonceB64: toB64(nonce),
    ciphertextB64: toB64(new Uint8Array(ciphertext)),
  };
};

export const credentialIdToB64url = toB64url;
export const credentialIdFromB64url = fromB64url;
export const randomMmk = (): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(32));

/* -------------------------------------------------------------------------- */
/* Final review I7: verify the unwrapped MMK; try every passkey wrapper        */
/* -------------------------------------------------------------------------- */

/** The latest Protected generation's DEK wrap (metadata only — no payload). */
export type MmkKeyCheck = {
  backupId: string;
  wrappedDek: { nonceB64: string; ciphertextB64: string; tagB64: string };
};

// Must match @stack/memory mmk.ts `dekAad`.
const dekAad = (backupId: string): Uint8Array =>
  enc.encode(JSON.stringify({ purpose: 'wrap-dek', backupId }));

/** True when `mmk` unwraps the check's DEK (AES-GCM authenticates it). */
export const mmkOpensWrappedDek = async (options: {
  mmk: Uint8Array;
  check: MmkKeyCheck;
}): Promise<boolean> => {
  try {
    const key = await subtle().importKey(
      'raw',
      bs(options.mmk),
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );
    const combined = new Uint8Array([
      ...fromB64(options.check.wrappedDek.ciphertextB64),
      ...fromB64(options.check.wrappedDek.tagB64),
    ]);
    const dek = new Uint8Array(
      await subtle().decrypt(
        {
          name: 'AES-GCM',
          iv: bs(fromB64(options.check.wrappedDek.nonceB64)),
          additionalData: bs(dekAad(options.check.backupId)),
        },
        key,
        bs(combined),
      ),
    );
    dek.fill(0);
    return true;
  } catch {
    return false;
  }
};

export type PasskeyMmkSelection =
  | { status: 'ok'; mmk: Uint8Array }
  /** No listed passkey produced a PRF output here. */
  | { status: 'no-prf' }
  /** PRF worked, but no wrapper yielded a key that opens the account's Memory. */
  | { status: 'no-match' };

/**
 * Final review I7: pick the passkey-wrapped MMK that actually opens this
 * account's Memory. An abandoned protect can leave a wrapper for a key nothing
 * uses (possibly for the same passkey, listed first); taking the first wrapper
 * that unwraps would then fail every recovery. So: try EVERY wrapper (asking
 * each passkey for its PRF once), skip a passkey without PRF instead of
 * stopping, and accept a key only when it opens `check` (the latest Protected
 * generation's DEK). With no check available, the first key that unwraps is
 * used, as before.
 */
export const selectPasskeyMmk = async (options: {
  wrappers: { publicIdentifier: string | null; mmkWrapper: unknown }[];
  getPrf: (publicIdentifier: string) => Promise<Uint8Array | null>;
  check: MmkKeyCheck | null;
}): Promise<PasskeyMmkSelection> => {
  const prfByCredential = new Map<string, Uint8Array | null>();
  let anyPrf = false;
  try {
    for (const wrapper of options.wrappers) {
      if (!wrapper.publicIdentifier) continue;
      if (!prfByCredential.has(wrapper.publicIdentifier))
        prfByCredential.set(
          wrapper.publicIdentifier,
          await options.getPrf(wrapper.publicIdentifier),
        );
      const prf = prfByCredential.get(wrapper.publicIdentifier) ?? null;
      if (!prf) continue;
      anyPrf = true;
      let mmk: Uint8Array;
      try {
        mmk = await unwrapMmkWithPrf({
          stored: wrapper.mmkWrapper as StoredMmkWrapper,
          prfOutput: prf,
        });
      } catch {
        continue; // not this passkey's wrapper
      }
      if (
        !options.check ||
        (await mmkOpensWrappedDek({ mmk, check: options.check }))
      )
        return { status: 'ok', mmk };
      mmk.fill(0); // a leftover key that opens nothing — try the next wrapper
    }
  } finally {
    for (const prf of prfByCredential.values()) prf?.fill(0);
  }
  return anyPrf ? { status: 'no-match' } : { status: 'no-prf' };
};
