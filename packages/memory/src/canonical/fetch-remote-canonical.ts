import { CIPHER_VERSION, open } from '../remote/cipher.js';
import { unwrapDekWithMmk } from '../remote/mmk.js';
import { parseBundle } from '../remote/bundle-codec.js';
import { RemoteMemoryError, type RemoteMemoryBackend } from '../remote/backend.js';
import { hashBytes } from '../store.js';
import { portableRegistrySnapshotSchema, type LocalRegistry, type PortableRegistrySnapshot } from '../project/registry.js';
import { convertV1Bundle } from './convert-v1.js';
import { canonicalMainManifestSchema, emptyCanonicalMain, type CanonicalMainManifest } from './domain.js';

const splitPayload = (payload: Uint8Array) => {
  const buf = Buffer.from(payload);
  return { nonce: buf.subarray(0, 12), ciphertext: buf.subarray(12, buf.length - 16), tag: buf.subarray(buf.length - 16) };
};

const protectedAad = (backupId: string): Buffer =>
  Buffer.from(JSON.stringify({ v: CIPHER_VERSION, mode: 'protected', backupId }), 'utf8');

export type RemoteCanonicalObject = { contentHash: string; bytes: Uint8Array };

/**
 * Fetch Cloud's latest generation and decode it into canonical Memory — reading
 * `canonicalB64` directly for a v2 generation, or deterministically converting a
 * v1 generation via `convertV1Bundle`. `localRegistry` is used ONLY as the v1
 * fallback's identity source (spec section 9.2).
 *
 * Also returns every content object the bundle itself carries, hash-verified.
 * Task 13 found this necessary: canonical push/pull exchange only the small
 * `main.json` metadata (never touching the content store directly), but a
 * materialize on a SECOND machine that never had this content locally still
 * needs the actual bytes — and the only place those bytes exist in a pull is
 * this same already-fetched, already-decrypted bundle. Without this, a
 * cross-machine pull would restore a canonical manifest whose documents point
 * at content that was never written anywhere on the pulling machine.
 *
 * Also returns the bundle's portable project-registry snapshot (`registryB64`),
 * hash-verified, when present — read-only, Task 13 Important-6: a machine that
 * has never locally learned a project's git claim can still use the SAME
 * snapshot that traveled with this generation to locate that project's
 * directory during materialize (never to mint a Project ID or create a
 * binding — only the local registry does that).
 */
export const fetchRemoteCanonical = async (options: {
  backend: RemoteMemoryBackend;
  mmk?: Buffer;
  localRegistry: LocalRegistry;
}): Promise<{
  generation: number;
  main: CanonicalMainManifest;
  objects: RemoteCanonicalObject[];
  registrySnapshot: PortableRegistrySnapshot | undefined;
} | null> => {
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
  const objects: RemoteCanonicalObject[] = bundle.objects.map((object) => {
    const bytes = Buffer.from(object.bytesB64, 'base64');
    if (hashBytes(bytes) !== object.contentHash)
      throw new RemoteMemoryError('integrity', 'A bundled object does not match its content hash.');
    return { contentHash: object.contentHash, bytes };
  });
  let registrySnapshot: PortableRegistrySnapshot | undefined;
  if (bundle.registryB64 && bundle.registrySha256) {
    const registryBytes = Buffer.from(bundle.registryB64, 'base64');
    if (hashBytes(registryBytes) !== bundle.registrySha256)
      throw new RemoteMemoryError('integrity', 'The bundled project registry does not match its hash.');
    registrySnapshot = portableRegistrySnapshotSchema.parse(JSON.parse(registryBytes.toString('utf8')));
  }
  return { generation: meta.generation, main: main ?? emptyCanonicalMain(), objects, registrySnapshot };
};
