import { CIPHER_VERSION, open } from '../remote/cipher.js';
import { unwrapDekWithMmk } from '../remote/mmk.js';
import { parseBundle } from '../remote/bundle-codec.js';
import { RemoteMemoryError, type RemoteMemoryBackend } from '../remote/backend.js';
import { hashBytes } from '../store.js';
import type { LocalRegistry } from '../project/registry.js';
import { convertV1Bundle } from './convert-v1.js';
import { canonicalMainManifestSchema, emptyCanonicalMain, type CanonicalMainManifest } from './domain.js';

const splitPayload = (payload: Uint8Array) => {
  const buf = Buffer.from(payload);
  return { nonce: buf.subarray(0, 12), ciphertext: buf.subarray(12, buf.length - 16), tag: buf.subarray(buf.length - 16) };
};

const protectedAad = (backupId: string): Buffer =>
  Buffer.from(JSON.stringify({ v: CIPHER_VERSION, mode: 'protected', backupId }), 'utf8');

/** Fetch Cloud's latest generation and decode it into canonical Memory — reading
 * `canonicalB64` directly for a v2 generation, or deterministically converting a
 * v1 generation via `convertV1Bundle`. `localRegistry` is used ONLY as the v1
 * fallback's identity source (spec section 9.2). */
export const fetchRemoteCanonical = async (options: {
  backend: RemoteMemoryBackend;
  mmk?: Buffer;
  localRegistry: LocalRegistry;
}): Promise<{ generation: number; main: CanonicalMainManifest } | null> => {
  const meta = await options.backend.getLatest();
  if (!meta) return null;
  const payload = await options.backend.getPayload(meta.backupId);
  if (hashBytes(payload) !== meta.payloadSha256)
    throw new RemoteMemoryError('integrity', 'Payload failed its integrity hash.');

  let bundleBytes: Uint8Array;
  if (meta.privacyMode === 'standard') {
    bundleBytes = payload;
  } else {
    if (!options.mmk) throw new RemoteMemoryError('mmk-required', 'Protected recovery requires the Memory Master Key.');
    if (!meta.wrappedDek) throw new RemoteMemoryError('not-protected', 'Protected generation is missing its wrapped DEK.');
    const dek = unwrapDekWithMmk(meta.wrappedDek, options.mmk, meta.backupId);
    bundleBytes = open(splitPayload(payload), dek, protectedAad(meta.backupId));
  }

  const bundle = parseBundle(bundleBytes);
  const main = bundle.canonicalB64
    ? canonicalMainManifestSchema.parse(JSON.parse(Buffer.from(bundle.canonicalB64, 'base64').toString('utf8')))
    : convertV1Bundle(bundle, { localRegistry: options.localRegistry });
  return { generation: meta.generation, main: main ?? emptyCanonicalMain() };
};
