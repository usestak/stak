import { createHash } from 'node:crypto';

import type { CloudBlobStore } from '@stack/cloud-server';

import { cloudEnv } from './env';
import { serviceClient } from './supabase';

const finalKey = (userId: string, contentHash: string) =>
  `snapshots/${userId}/${contentHash.replace(':', '_')}.tar`;
const pendingKey = (ticket: string) =>
  `pending/${createHash('sha256').update(ticket).digest('hex')}.tar`;

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
  };
};
