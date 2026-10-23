import { CIPHER_VERSION, open } from '../remote/cipher.js';
import { unwrapDekWithMmk } from '../remote/mmk.js';
import { parseBundle } from '../remote/bundle-codec.js';
import { RemoteMemoryError, type MemoryGenerationMeta, type RemoteMemoryBackend } from '../remote/backend.js';
import { protectInProgressMessage } from '../remote/modes.js';
import { hashBytes } from '../store.js';
import { portableRegistrySnapshotSchema, type LocalRegistry, type PortableRegistrySnapshot } from '../project/registry.js';
import { convertV1Bundle } from './convert-v1.js';
import { canonicalMainManifestSchema, emptyCanonicalMain, type CanonicalMainManifest } from './domain.js';
import type { CanonicalBase } from './store.js';

const splitPayload = (payload: Uint8Array) => {
  const buf = Buffer.from(payload);
  return { nonce: buf.subarray(0, 12), ciphertext: buf.subarray(12, buf.length - 16), tag: buf.subarray(buf.length - 16) };
};

const protectedAad = (backupId: string): Buffer =>
  Buffer.from(JSON.stringify({ v: CIPHER_VERSION, mode: 'protected', backupId }), 'utf8');

export type RemoteCanonicalObject = { contentHash: string; bytes: Uint8Array };

/**
 * Task 13 fix round 3 (7(c) minor): generation `n` is gone from the committed
 * set because `stak memory protect` retired it — find the committed Protected
 * replica that re-encrypts it (`replicaOf`), whose plaintext is byte-identical.
 */
const replicaOfRetiredGeneration = async (
  backend: RemoteMemoryBackend,
  generation: number,
): Promise<MemoryGenerationMeta | null> => {
  for (const candidate of await backend.listGenerations()) {
    if (candidate.privacyMode !== 'protected' || typeof candidate.replicaOf !== 'string') continue;
    const original = await backend.getGenerationById(candidate.replicaOf);
    if (original && original.generation === generation) return candidate;
  }
  return null;
};

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
 *
 * `generation`, when given, fetches that EXACT generation instead of Cloud's
 * current latest (Task 13 fix round 2, finding 7 / spec Appendix A.4: seeding
 * `canonical/base.json` from the specific Cloud generation this machine last
 * pushed or recovered in v1 — never assuming Cloud's current latest is this
 * machine's base). When that generation was retired by `stak memory protect`,
 * its Protected replica (same plaintext) is used instead.
 *
 * Fetching LATEST fails closed with `RemoteMemoryError('protect-in-progress')`
 * when latest is a Protected replica but the account is still Standard (an
 * interrupted `stak memory protect`).
 */
/**
 * Task 13 fix round 7 — stale merge bases. The merge base this machine
 * recorded is only trustworthy while Cloud still holds that generation's
 * content. Returns `base` unchanged when:
 *  - its generation is still committed (one `getGeneration` call — the common
 *    case);
 *  - its generation equals the account's commit counter: nothing was committed
 *    since this machine's base, so its local Memory is still the legitimate
 *    continuation (fix round 5's fast-forward after the latest is retired);
 *  - its generation was retired by `stak memory protect` and has a committed
 *    Protected replica (`replicaOf`) holding the same plaintext.
 * Otherwise (e.g. Delete Cloud Memory retired it and another machine has since
 * re-uploaded older content) the base is treated as EMPTY for the merge, so
 * every difference becomes an ordinary conflict and a document only one side
 * has is kept — nothing is silently overwritten or deleted on the strength of
 * a base Cloud no longer has.
 */
export const effectiveCanonicalBase = async (
  backend: RemoteMemoryBackend | null,
  base: CanonicalBase | null,
): Promise<CanonicalBase | null> => {
  if (!base || !backend) return base;
  if ((await backend.getGeneration(base.generation)) !== null) return base;
  if ((await backend.getProfile())?.latestGeneration === base.generation) return base;
  if ((await replicaOfRetiredGeneration(backend, base.generation)) !== null) return base;
  return null;
};

export const fetchRemoteCanonical = async (options: {
  backend: RemoteMemoryBackend;
  mmk?: Buffer;
  localRegistry: LocalRegistry;
  generation?: number;
}): Promise<{
  generation: number;
  /** The committed generation the returned content actually came from (Task
   * 14 fix round 1). Differs from `generation` only when `generation` is the
   * account's commit counter (highest generation retired) or a protect replica
   * was read for an explicit `generation`. A pending merge records THIS, so
   * `stak memory resolve`/`diff` can fetch exactly that content again. */
  contentGeneration: number;
  main: CanonicalMainManifest;
  objects: RemoteCanonicalObject[];
  registrySnapshot: PortableRegistrySnapshot | undefined;
} | null> => {
  const meta =
    options.generation !== undefined
      ? ((await options.backend.getGeneration(options.generation)) ??
        (await replicaOfRetiredGeneration(options.backend, options.generation)))
      : await options.backend.getLatest();
  // Task 13 fix rounds 5-6: no committed generation at all (never pushed, or
  // Delete Cloud Memory retired everything) is "nothing in Cloud" — null —
  // NEVER empty content, which a machine with an older base would merge as
  // "Cloud deleted everything" and turn into native deletes. A push then
  // fast-forwards (see `pushCanonicalMemory`) and `publishCanonicalGeneration`
  // supplies the commit counter as its parent.
  if (!meta) return null;
  // When latest IS committed, the returned `generation` is the account's commit
  // counter (`profile.latestGeneration`, what `createGeneration` checks
  // `expectedParent` against in both backends) whenever it is higher than the
  // latest committed generation's own number — i.e. the highest generation was
  // retired but others remain. Content still comes from the latest committed one.
  const head =
    options.generation === undefined ? ((await options.backend.getProfile())?.latestGeneration ?? null) : null;
  // Task 13 fix round 3: Cloud latest is a Protected replica while the account
  // is still Standard -> `stak memory protect` was interrupted mid-migration.
  // Fail closed (no merge, no materialize, no native deletes) until protect is
  // re-run and finalizes.
  if (options.generation === undefined && meta.privacyMode === 'protected' && typeof meta.replicaOf === 'string') {
    const profile = await options.backend.getProfile();
    if ((profile?.privacyMode ?? 'standard') === 'standard')
      throw new RemoteMemoryError('protect-in-progress', await protectInProgressMessage(options.backend));
  }
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
  return {
    generation: head !== null && head > meta.generation ? head : meta.generation,
    contentGeneration: meta.generation,
    main: main ?? emptyCanonicalMain(),
    objects,
    registrySnapshot,
  };
};
