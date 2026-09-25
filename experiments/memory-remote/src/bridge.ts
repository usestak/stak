/**
 * CLI ↔ browser zero-knowledge recovery bridge (Phase 14B1).
 *
 * SPIKE ONLY. WebAuthn PRF happens in the browser, but Stack is a CLI. This bridge
 * transfers the unlocked MMK from the browser to the CLI so that Stack's server
 * only ever relays an OPAQUE envelope and never learns the MMK.
 *
 * Construction (all standard, available identically in Node 22 and browsers via
 * the Web Crypto API — no library, no custom crypto):
 *   - ephemeral ECDH on P-256 (both sides generate a keypair)
 *   - HKDF-SHA-256 to derive the transfer key from the ECDH shared secret
 *   - AES-256-GCM to encrypt the MMK, with associated data binding the transfer to
 *     the one-time session, the intended CLI ephemeral public key, the Stack user,
 *     an expiry, and a protocol version — which defeats replay and misbinding.
 *
 * The CLI ephemeral PRIVATE key never leaves the CLI. The browser private key never
 * leaves the browser. The server sees only public keys + ciphertext.
 *
 * TRUST BOUNDARY (documented, not hand-waved): the browser code that unlocks and
 * re-encrypts the MMK is served by Stack. If Stack served malicious JavaScript, it
 * could exfiltrate the decrypted MMK in the browser. This bridge does NOT defend
 * against a malicious Stack application bundle. See the spike doc §"Browser trust".
 */
import { KDF_LABELS } from './kdf.js';

export const BRIDGE_VERSION = 'stack-mem-bridge-v1' as const;

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

const b64 = (bytes: ArrayBuffer | Uint8Array): string =>
  Buffer.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  ).toString('base64');
const fromB64 = (value: string): Buffer => Buffer.from(value, 'base64');

/** Copy into an ArrayBuffer-backed view so Web Crypto's BufferSource types accept it. */
const bs = (x: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(x.byteLength);
  copy.set(x);
  return copy;
};

/** Public session descriptor the CLI creates and the browser consumes. */
export type RecoverySession = {
  sessionId: string;
  userId: string;
  version: typeof BRIDGE_VERSION;
  cliPublicKeyB64: string; // raw P-256 point; safe to publish
  expiresAt: string; // ISO
};

/** Opaque envelope the browser produces; the server relays it verbatim. */
export type BridgeEnvelope = {
  sessionId: string;
  version: typeof BRIDGE_VERSION;
  browserPublicKeyB64: string;
  nonceB64: string;
  ciphertextB64: string; // AES-GCM output (ciphertext||tag)
};

export class BridgeError extends Error {
  constructor(
    public readonly code:
      'expired' | 'session-mismatch' | 'version-mismatch' | 'decrypt-failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BridgeError';
  }
}

const ecdhKeyPair = (): Promise<CryptoKeyPair> =>
  subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);

const importPublic = (raw: Uint8Array): Promise<CryptoKey> =>
  subtle().importKey(
    'raw',
    bs(raw),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

const exportPublic = async (key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await subtle().exportKey('raw', key));

/** The associated data both sides authenticate — binds the transfer to context. */
const bindingAad = (options: {
  sessionId: string;
  userId: string;
  expiresAt: string;
  cliPublicKeyB64: string;
  browserPublicKeyB64: string;
}): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      v: BRIDGE_VERSION,
      sessionId: options.sessionId,
      userId: options.userId,
      expiresAt: options.expiresAt,
      cli: options.cliPublicKeyB64,
      browser: options.browserPublicKeyB64,
    }),
  );

const deriveTransferKey = async (
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  sessionId: string,
): Promise<CryptoKey> => {
  const shared = await subtle().deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256,
  );
  const hkdfKey = await subtle().importKey('raw', shared, 'HKDF', false, [
    'deriveBits',
  ]);
  const transferBits = await subtle().deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: bs(new TextEncoder().encode(sessionId)),
      info: bs(new TextEncoder().encode(KDF_LABELS.bridge)),
    },
    hkdfKey,
    256,
  );
  return subtle().importKey('raw', transferBits, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
};

/** CLI side: create a one-time recovery session. Keeps the private key locally. */
export const createRecoverySession = async (options: {
  userId: string;
  ttlMs: number;
  now?: () => Date;
}): Promise<{ session: RecoverySession; cliPrivateKey: CryptoKey }> => {
  const now = options.now ?? (() => new Date());
  const pair = await ecdhKeyPair();
  const cliPublicKeyB64 = b64(await exportPublic(pair.publicKey));
  const session: RecoverySession = {
    sessionId: globalThis.crypto.randomUUID(),
    userId: options.userId,
    version: BRIDGE_VERSION,
    cliPublicKeyB64,
    expiresAt: new Date(now().getTime() + options.ttlMs).toISOString(),
  };
  return { session, cliPrivateKey: pair.privateKey };
};

/** Browser side: unlock happened; encrypt the MMK for exactly this CLI session. */
export const sealMmkForCli = async (options: {
  session: RecoverySession;
  mmk: Uint8Array;
}): Promise<BridgeEnvelope> => {
  if (options.session.version !== BRIDGE_VERSION)
    throw new BridgeError('version-mismatch', 'Unsupported bridge version.');
  const cliPublic = await importPublic(
    fromB64(options.session.cliPublicKeyB64),
  );
  const pair = await ecdhKeyPair();
  const browserPublicKeyB64 = b64(await exportPublic(pair.publicKey));
  const transferKey = await deriveTransferKey(
    pair.privateKey,
    cliPublic,
    options.session.sessionId,
  );
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = bindingAad({
    sessionId: options.session.sessionId,
    userId: options.session.userId,
    expiresAt: options.session.expiresAt,
    cliPublicKeyB64: options.session.cliPublicKeyB64,
    browserPublicKeyB64,
  });
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: bs(aad) },
    transferKey,
    bs(options.mmk),
  );
  return {
    sessionId: options.session.sessionId,
    version: BRIDGE_VERSION,
    browserPublicKeyB64,
    nonceB64: b64(nonce),
    ciphertextB64: b64(ciphertext),
  };
};

/** CLI side: open the relayed envelope with the locally-held private key. */
export const openMmkFromEnvelope = async (options: {
  session: RecoverySession;
  cliPrivateKey: CryptoKey;
  envelope: BridgeEnvelope;
  now?: () => Date;
}): Promise<Buffer> => {
  const now = options.now ?? (() => new Date());
  if (options.envelope.version !== BRIDGE_VERSION)
    throw new BridgeError('version-mismatch', 'Unsupported bridge version.');
  if (options.envelope.sessionId !== options.session.sessionId)
    throw new BridgeError(
      'session-mismatch',
      'Envelope is for a different recovery session.',
    );
  if (now().getTime() > new Date(options.session.expiresAt).getTime())
    throw new BridgeError('expired', 'Recovery session has expired.');

  const browserPublic = await importPublic(
    fromB64(options.envelope.browserPublicKeyB64),
  );
  const transferKey = await deriveTransferKey(
    options.cliPrivateKey,
    browserPublic,
    options.session.sessionId,
  );
  const aad = bindingAad({
    sessionId: options.session.sessionId,
    userId: options.session.userId,
    expiresAt: options.session.expiresAt,
    cliPublicKeyB64: options.session.cliPublicKeyB64,
    browserPublicKeyB64: options.envelope.browserPublicKeyB64,
  });
  try {
    const plaintext = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: bs(fromB64(options.envelope.nonceB64)),
        additionalData: bs(aad),
      },
      transferKey,
      bs(fromB64(options.envelope.ciphertextB64)),
    );
    return Buffer.from(plaintext);
  } catch (error) {
    throw new BridgeError(
      'decrypt-failed',
      'Could not decrypt the recovery envelope (wrong session key, tamper, or misbinding).',
      { cause: error },
    );
  }
};

/**
 * Minimal one-time session store (server-side relay model). The server holds only
 * the public session + the opaque envelope, and enforces single-use + expiry. It
 * never sees private keys or the MMK.
 */
export class OneTimeSessionRelay {
  private readonly sessions = new Map<
    string,
    { session: RecoverySession; consumed: boolean }
  >();
  private readonly envelopes = new Map<string, BridgeEnvelope>();

  publishSession(session: RecoverySession): void {
    this.sessions.set(session.sessionId, { session, consumed: false });
  }

  getSession(sessionId: string): RecoverySession | null {
    return this.sessions.get(sessionId)?.session ?? null;
  }

  submitEnvelope(envelope: BridgeEnvelope): void {
    this.envelopes.set(envelope.sessionId, envelope);
  }

  /** One-time consumption: a replayed fetch of the same session is refused. */
  consumeEnvelope(sessionId: string): BridgeEnvelope {
    const entry = this.sessions.get(sessionId);
    if (!entry)
      throw new BridgeError('session-mismatch', 'Unknown recovery session.');
    if (entry.consumed)
      throw new BridgeError(
        'session-mismatch',
        'Recovery session already used.',
      );
    const envelope = this.envelopes.get(sessionId);
    if (!envelope)
      throw new BridgeError('session-mismatch', 'No envelope submitted yet.');
    entry.consumed = true;
    return envelope;
  }
}
