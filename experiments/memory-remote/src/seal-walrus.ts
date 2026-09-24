/**
 * Option B — Seal + Walrus adapter SKETCH.
 *
 * SPIKE ONLY, NOT WIRED, NO NETWORK. This file is compile-valid documentation of
 * how a Seal+Walrus backend WOULD be composed, plus an env-gated config reader so
 * an opt-in integration test can run against a developer's own testnet setup. It
 * deliberately does NOT import @mysten/seal or @mysten/walrus (those are heavy,
 * network-bound, and out of scope for an offline spike) and it contains NO
 * secrets. Nothing here has been run against a live network.
 *
 * Grounding (official docs, fetched 2026-09-24):
 *  - Walrus stores immutable public blobs; "All blobs uploaded to Walrus are
 *    publicly available" — it provides NO confidentiality. Encryption must happen
 *    before upload. (docs.wal.app: system-overview/core-concepts)
 *  - Storage is epoch-bounded (~2 weeks/epoch on mainnet); blobs expire and must
 *    be renewed via the Sui OBJECT id (not the blob id). Requires a Sui wallet +
 *    WAL (storage) + SUI (gas). (docs.wal.app: storing-blobs, storage-costs)
 *  - Seal supplies encryption + access control: identity-based encryption, t-of-n
 *    threshold key servers, access enforced by `seal_approve*` Move functions on
 *    Sui, decryption authorized via wallet-signed, short-TTL session keys.
 *    (docs.sui.io/sui-stack/seal: design, using-seal)
 *  - Seal encrypt helpers can return a 32-byte backup/recovery symmetric key for
 *    "break-glass" disaster recovery. Committee (MPC) mode is testnet-only. SDK is
 *    beta. (docs.sui.io/sui-stack/seal)
 *
 * KEY DESIGN CONSEQUENCE for Stack's no-wallet UX requirement: Seal ties identity
 * and recovery to a Sui wallet keypair. Recovery on a brand-new machine requires
 * restoring that wallet (seed phrase) OR the exported break-glass key. Stack must
 * NOT put an owner private key in the web server and must NOT silently custody a
 * user's blockchain owner key. Reconciling Seal with "normal developer, no wallet"
 * is the central open question for Option B (see the spike doc, §Option B).
 */

export const SEAL_WALRUS_SCHEME = 'option-b-seal-walrus-v0-sketch' as const;

export class SpikeNotWiredError extends Error {
  constructor(what: string) {
    super(
      `${what} is a Phase 14B0 sketch and is not wired to any network. ` +
        `Enable an opt-in integration test with explicit env configuration to exercise it.`,
    );
    this.name = 'SpikeNotWiredError';
  }
}

/** Config an opt-in integration test would read from the environment. */
export type SealWalrusConfig = {
  suiNetwork: 'testnet' | 'mainnet';
  sealPackageId: string; // deployed Move access-policy package
  keyServerObjectIds: string[]; // t-of-n key servers
  threshold: number;
  walrusUploadRelayUrl: string;
  storageEpochs: number; // blob lifetime to purchase
};

/**
 * Read Option B config from env WITHOUT requiring or accepting any secret key.
 * Returns null when not configured, so tests skip cleanly by default. No wallet
 * private key is read here — signing is the developer's responsibility in their
 * own opt-in harness, never Stack's server.
 */
export const readSealWalrusConfig = (
  env: NodeJS.ProcessEnv = process.env,
): SealWalrusConfig | null => {
  if (env.STACK_SPIKE_SEAL_WALRUS !== '1') return null;
  const packageId = env.STACK_SPIKE_SEAL_PACKAGE_ID;
  const keyServers = env.STACK_SPIKE_SEAL_KEY_SERVERS;
  const relay = env.STACK_SPIKE_WALRUS_UPLOAD_RELAY;
  if (!packageId || !keyServers || !relay) return null;
  const network =
    env.STACK_SPIKE_SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  return {
    suiNetwork: network,
    sealPackageId: packageId,
    keyServerObjectIds: keyServers.split(',').map((value) => value.trim()),
    threshold: Number(env.STACK_SPIKE_SEAL_THRESHOLD ?? '2'),
    walrusUploadRelayUrl: relay,
    storageEpochs: Number(env.STACK_SPIKE_WALRUS_EPOCHS ?? '12'),
  };
};

/**
 * The composition Option B implies. Methods throw until an opt-in harness wires
 * the real SDKs; the signatures document the intended contract.
 */
export interface SealWalrusBackend {
  /** Seal-encrypt bundle bytes client-side, then store the blob on Walrus. */
  protect(bundleBytes: Uint8Array): Promise<{ blobId: string }>;
  /** Fetch the Walrus blob and Seal-decrypt it (requires a session key). */
  recover(blobId: string): Promise<Uint8Array>;
}

export const createSealWalrusBackendSketch = (
  config: SealWalrusConfig,
): SealWalrusBackend => ({
  protect: () => {
    throw new SpikeNotWiredError(`Seal+Walrus protect on ${config.suiNetwork}`);
  },
  recover: () => {
    throw new SpikeNotWiredError(`Seal+Walrus recover on ${config.suiNetwork}`);
  },
});
