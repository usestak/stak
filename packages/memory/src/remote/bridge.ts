/**
 * CLI ↔ browser zero-knowledge recovery/enrollment bridge (production).
 *
 * WebAuthn PRF happens in the browser; Stack is a CLI. This bridge transfers the
 * MMK between browser and CLI so Stack's server only relays an OPAQUE envelope and
 * never learns the MMK. Standard Web Crypto (identical in Node 22 and browsers):
 * ephemeral ECDH P-256 → HKDF-SHA-256 → AES-256-GCM, with associated data binding
 * the transfer to a one-time session, the intended peer public key, the Stack
 * user, an expiry, and a protocol version — defeating replay and misbinding.
 *
 * TRUST BOUNDARY (documented, accepted for V0): the browser code that unlocks and
 * re-encrypts the MMK is served by Stack. A malicious Stack-served bundle could
 * exfiltrate the MMK in the browser. This bridge does NOT defend against that.
 *
 * The bridge is symmetric: it transfers an MMK from whichever side holds it to the
 * other. `direction` records intent ('recovery' = browser→CLI unlock;
 * 'enrollment' = CLI→browser during setup) and is authenticated in the AAD.
 */
import { KDF_LABELS } from './kdf.js';

export const BRIDGE_VERSION = 'stack-mem-bridge-v1' as const;

export type BridgeDirection = 'recovery' | 'enrollment';

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

/** Public session descriptor the initiator creates and the peer consumes. */
export type RecoverySession = {
  sessionId: string;
  userId: string;
  version: typeof BRIDGE_VERSION;
  direction: BridgeDirection;
  initiatorPublicKeyB64: string;
  expiresAt: string;
};

/** Opaque envelope the peer produces; the server relays it verbatim. */
export type BridgeEnvelope = {
  sessionId: string;
  version: typeof BRIDGE_VERSION;
  peerPublicKeyB64: string;
  nonceB64: string;
  ciphertextB64: string;
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

const bindingAad = (options: {
  sessionId: string;
  userId: string;
  direction: BridgeDirection;
  expiresAt: string;
  initiatorPublicKeyB64: string;
  peerPublicKeyB64: string;
}): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      v: BRIDGE_VERSION,
      sessionId: options.sessionId,
      userId: options.userId,
      direction: options.direction,
      expiresAt: options.expiresAt,
      initiator: options.initiatorPublicKeyB64,
      peer: options.peerPublicKeyB64,
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

/** Initiator side: create a one-time session, keeping the private key locally. */
export const createRecoverySession = async (options: {
  userId: string;
  ttlMs: number;
  direction?: BridgeDirection;
  now?: () => Date;
}): Promise<{ session: RecoverySession; initiatorPrivateKey: CryptoKey }> => {
  const now = options.now ?? (() => new Date());
  const pair = await ecdhKeyPair();
  const initiatorPublicKeyB64 = b64(await exportPublic(pair.publicKey));
  const session: RecoverySession = {
    sessionId: globalThis.crypto.randomUUID(),
    userId: options.userId,
    version: BRIDGE_VERSION,
    direction: options.direction ?? 'recovery',
    initiatorPublicKeyB64,
    expiresAt: new Date(now().getTime() + options.ttlMs).toISOString(),
  };
  return { session, initiatorPrivateKey: pair.privateKey };
};

/** Peer side: encrypt the MMK for exactly this session and initiator. */
export const sealMmkForPeer = async (options: {
  session: RecoverySession;
  mmk: Uint8Array;
}): Promise<BridgeEnvelope> => {
  if (options.session.version !== BRIDGE_VERSION)
    throw new BridgeError('version-mismatch', 'Unsupported bridge version.');
  const initiatorPublic = await importPublic(
    fromB64(options.session.initiatorPublicKeyB64),
  );
  const pair = await ecdhKeyPair();
  const peerPublicKeyB64 = b64(await exportPublic(pair.publicKey));
  const transferKey = await deriveTransferKey(
    pair.privateKey,
    initiatorPublic,
    options.session.sessionId,
  );
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = bindingAad({
    sessionId: options.session.sessionId,
    userId: options.session.userId,
    direction: options.session.direction,
    expiresAt: options.session.expiresAt,
    initiatorPublicKeyB64: options.session.initiatorPublicKeyB64,
    peerPublicKeyB64,
  });
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: bs(aad) },
    transferKey,
    bs(options.mmk),
  );
  return {
    sessionId: options.session.sessionId,
    version: BRIDGE_VERSION,
    peerPublicKeyB64,
    nonceB64: b64(nonce),
    ciphertextB64: b64(ciphertext),
  };
};

/** Initiator side: open the relayed envelope with the locally-held private key. */
export const openMmkFromEnvelope = async (options: {
  session: RecoverySession;
  initiatorPrivateKey: CryptoKey;
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

  const peerPublic = await importPublic(
    fromB64(options.envelope.peerPublicKeyB64),
  );
  const transferKey = await deriveTransferKey(
    options.initiatorPrivateKey,
    peerPublic,
    options.session.sessionId,
  );
  const aad = bindingAad({
    sessionId: options.session.sessionId,
    userId: options.session.userId,
    direction: options.session.direction,
    expiresAt: options.session.expiresAt,
    initiatorPublicKeyB64: options.session.initiatorPublicKeyB64,
    peerPublicKeyB64: options.envelope.peerPublicKeyB64,
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
