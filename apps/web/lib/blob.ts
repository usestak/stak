import { createHash } from 'node:crypto';

import type { CloudBlobStore } from '@stack/cloud-server';

import { cloudEnv } from './env';
import { serviceClient } from './supabase';

const finalKey = (userId: string, contentHash: string) =>
  `snapshots/${userId}/${contentHash.replace(':', '_')}.tar`;
const pendingKey = (ticket: string) =>
  `pending/${createHash('sha256').update(ticket).digest('hex')}.tar`;
// Structurally distinct top-level prefix from `snapshots/` — a review-artifact payload is
// keyed by its own globally-unique artifact id, never a content hash, so it can never
// collide with a Memory snapshot even if the underlying bytes happened to match.
const reviewPayloadKey = (userId: string, reviewArtifactId: string) =>
  `review-artifacts/${userId}/${reviewArtifactId}.json`;

const toBytes = async (blob: Blob | null): Promise<Uint8Array | null> =>
  blob ? new Uint8Array(await blob.arrayBuffer()) : null;

/**
 * Private Supabase Storage blob store. Objects live under a per-user namespace;
 * the bucket has no public read policy and all access is mediated server-side
 * after authorization. Path structure is not authorization on its own.
 */
export const supabaseBlobStore = (): CloudBlobStore => {
  const bucket = cloudEnv().bucket;
  const storage = () => serviceClient().storage.from(bucket);
  return {
    putPending: async (ticket, bytes) => {
      const { error } = await storage().upload(
        pendingKey(ticket),
        Buffer.from(bytes),
        { contentType: 'application/octet-stream', upsert: true },
      );
      if (error) throw new Error(`Snapshot upload failed: ${error.message}`);
    },
    getPending: async (ticket) => {
      const { data } = await storage().download(pendingKey(ticket));
      return toBytes(data);
    },
    deletePending: async (ticket) => {
      await storage().remove([pendingKey(ticket)]);
    },
    put: async (userId, contentHash, bytes) => {
      const { error } = await storage().upload(
        finalKey(userId, contentHash),
        Buffer.from(bytes),
        { contentType: 'application/octet-stream', upsert: true },
      );
      if (error) throw new Error(`Snapshot store failed: ${error.message}`);
    },
    get: async (userId, contentHash) => {
      const { data } = await storage().download(finalKey(userId, contentHash));
      return toBytes(data);
    },
    has: async (userId, contentHash) => {
      const { data } = await storage().download(finalKey(userId, contentHash));
      return Boolean(data);
    },
    putReviewPayload: async (userId, reviewArtifactId, bytes) => {
      const { error } = await storage().upload(
        reviewPayloadKey(userId, reviewArtifactId),
        Buffer.from(bytes),
        { contentType: 'application/json', upsert: true },
      );
      if (error)
        throw new Error(`Review payload store failed: ${error.message}`);
    },
    getReviewPayload: async (userId, reviewArtifactId) => {
      const { data } = await storage().download(
        reviewPayloadKey(userId, reviewArtifactId),
      );
      return toBytes(data);
    },
    deleteReviewPayload: async (userId, reviewArtifactId) => {
      // Must genuinely throw on failure — the durable cleanup-retry mechanism (P5a gate §1)
      // depends on a real failure surfacing here, not being silently swallowed by the
      // Supabase client's {data,error} return convention.
      const { error } = await storage().remove([
        reviewPayloadKey(userId, reviewArtifactId),
      ]);
      if (error)
        throw new Error(`Review payload delete failed: ${error.message}`);
    },
  };
};
