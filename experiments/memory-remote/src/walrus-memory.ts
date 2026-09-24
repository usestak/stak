/**
 * Option C — Walrus Memory adapter SKETCH.
 *
 * SPIKE ONLY, NOT WIRED, NO NETWORK. Compile-valid documentation + env-gated
 * config reader. Does NOT import @mysten-incubation/memwal and contains NO
 * secrets. Nothing here has been run against a live network.
 *
 * Grounding (official docs, fetched 2026-09-24):
 *  - Walrus Memory is a "Portable memory layer for AI agents" — a SEMANTIC
 *    remember/recall store: the relayer "generates vector embeddings so your data
 *    is searchable by meaning." It is NOT a byte-exact blob API. Data is isolated
 *    by owner address + namespace; default namespace is "default".
 *    (docs.wal.app/walrus-memory, /sdk/api-reference)
 *  - Two modes:
 *      MemWal (managed relayer, default): the CLIENT SENDS PLAINTEXT to the
 *        relayer, which does embeddings + Seal encryption + Walrus upload. Plaintext
 *        exists at the relayer at ingest/recall time.
 *      MemWalManual: the client does Seal encryption + embeddings locally; "the
 *        relayer only receives encrypted payload + vector ... never plaintext."
 *  - All content is Seal-encrypted before Walrus; access via Sui "Programmable
 *    Permissions". (docs.wal.app/walrus-memory)
 *
 * TWO SEPARATE VERDICTS (do not conflate — see the spike doc, §Option C):
 *  1. As a Phase 14A BACKUP target: POOR FIT. It is a semantic store keyed by
 *     meaning, not a mechanism to preserve exact file bytes + restore descriptors
 *     + project identity + content hash + version. Round-tripping a byte-exact
 *     Phase 14A store through remember/recall is not what it is for.
 *  2. As a FUTURE cross-agent SEMANTIC memory layer (namespaces, remember/recall,
 *     auto capture/recall, multi-agent isolation): PROMISING, but orthogonal to
 *     native-memory disaster recovery and carries its own prompt-injection and
 *     managed-relayer-plaintext trust concerns.
 */

import { SpikeNotWiredError } from './seal-walrus.js';

export const WALRUS_MEMORY_SCHEME = 'option-c-walrus-memory-v0-sketch' as const;

export type WalrusMemoryMode = 'managed-relayer' | 'manual-client';

export type WalrusMemoryConfig = {
  mode: WalrusMemoryMode;
  relayerUrl: string;
  namespace: string;
  ownerAddress: string;
};

/**
 * Read Option C config from env. Returns null when not configured. Reads no
 * secret keys; a manual-client harness would supply its own Seal/Sui material.
 */
export const readWalrusMemoryConfig = (
  env: NodeJS.ProcessEnv = process.env,
): WalrusMemoryConfig | null => {
  if (env.STACK_SPIKE_WALRUS_MEMORY !== '1') return null;
  const relayerUrl = env.STACK_SPIKE_MEMWAL_RELAYER_URL;
  const ownerAddress = env.STACK_SPIKE_MEMWAL_OWNER;
  if (!relayerUrl || !ownerAddress) return null;
  const mode: WalrusMemoryMode =
    env.STACK_SPIKE_MEMWAL_MODE === 'manual-client'
      ? 'manual-client'
      : 'managed-relayer';
  return {
    mode,
    relayerUrl,
    namespace: env.STACK_SPIKE_MEMWAL_NAMESPACE ?? 'default',
    ownerAddress,
  };
};

/** Semantic surface Walrus Memory exposes (documented, not byte-exact backup). */
export interface WalrusMemoryClient {
  remember(text: string, namespace?: string): Promise<{ jobId: string }>;
  recall(
    query: string,
    namespace?: string,
  ): Promise<{ text: string; score: number }[]>;
}

export const createWalrusMemoryClientSketch = (
  config: WalrusMemoryConfig,
): WalrusMemoryClient => ({
  remember: () => {
    throw new SpikeNotWiredError(`Walrus Memory remember (${config.mode})`);
  },
  recall: () => {
    throw new SpikeNotWiredError(`Walrus Memory recall (${config.mode})`);
  },
});
