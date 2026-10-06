import {
  cliAuthStartResponseSchema,
  cliAuthTokenResponseSchema,
  commitEnvironmentVersionResponseSchema,
  finalizeSnapshotResponseSchema,
  getEnvironmentResponseSchema,
  getPublicStackResponseSchema,
  getPublicStackVersionResponseSchema,
  listMachinesResponseSchema,
  machineCheckinResponseSchema,
  meResponseSchema,
  prepareSnapshotResponseSchema,
  publicProfileResponseSchema,
  publishPublicStackVersionResponseSchema,
  setProjectLifecycleResponseSchema,
  snapshotDownloadResponseSchema,
  syncProjectsResponseSchema,
} from '@stack/spec';
import type {
  CliAuthStartRequest,
  CliAuthStartResponse,
  CliAuthTokenRequest,
  CliAuthTokenResponse,
  CommitEnvironmentVersionRequest,
  CommitEnvironmentVersionResponse,
  FinalizeSnapshotRequest,
  FinalizeSnapshotResponse,
  GetEnvironmentResponse,
  GetPublicStackResponse,
  GetPublicStackVersionResponse,
  ListMachinesResponse,
  MachineCheckinRequest,
  MachineCheckinResponse,
  MeResponse,
  PrepareSnapshotRequest,
  PrepareSnapshotResponse,
  PublicProfileResponse,
  ProjectLifecycle,
  PublishPublicStackVersionRequest,
  PublishPublicStackVersionResponse,
  SetProjectLifecycleResponse,
  SyncProjectsRequest,
  SyncProjectsResponse,
} from '@stack/spec';

import {
  CloudUnavailableError,
  NotAuthenticatedError,
  SnapshotDownloadFailedError,
  StackCloudError,
  cloudErrorFromResponse,
} from './errors.js';
import {
  createMemoryClientMethods,
  type CloudMemoryClient,
} from './memory-client.js';

export type DownloadedSnapshot = {
  contentHash: string;
  archiveHash: string;
  byteSize: number;
  bytes: Uint8Array;
};

export interface CloudClient {
  me(): Promise<MeResponse>;
  getEnvironment(name: string): Promise<GetEnvironmentResponse | null>;
  commitEnvironmentVersion(
    name: string,
    request: CommitEnvironmentVersionRequest,
  ): Promise<CommitEnvironmentVersionResponse>;
  prepareSnapshot(
    request: PrepareSnapshotRequest,
  ): Promise<PrepareSnapshotResponse>;
  uploadSnapshot(uploadTicket: string, bytes: Uint8Array): Promise<void>;
  finalizeSnapshot(
    request: FinalizeSnapshotRequest,
  ): Promise<FinalizeSnapshotResponse>;
  downloadSnapshot(contentHash: string): Promise<DownloadedSnapshot>;
  /** Phase P1: report this machine's check-in (presence only; no paths, no Memory). */
  machineCheckin(
    request: MachineCheckinRequest,
  ): Promise<MachineCheckinResponse>;
  listMachines(): Promise<ListMachinesResponse>;
  /** Phase P3: discovery sync of this account's project registry (safe name only; no paths). */
  syncProjects(request: SyncProjectsRequest): Promise<SyncProjectsResponse>;
  /** Phase P3: explicit account-side lifecycle intent (archive/unarchive) for one Project. */
  setProjectLifecycle(
    projectId: string,
    lifecycle: ProjectLifecycle,
  ): Promise<SetProjectLifecycleResponse>;
}

export interface CloudAuthClient {
  authStart(request: CliAuthStartRequest): Promise<CliAuthStartResponse>;
  authToken(request: CliAuthTokenRequest): Promise<CliAuthTokenResponse>;
  authRevoke(): Promise<void>;
}

export interface PublicStackClient {
  /** Anonymous read; resolves to null when the public Stack does not exist. */
  getPublicStack(
    owner: string,
    slug: string,
  ): Promise<GetPublicStackResponse | null>;
  getPublicStackVersion(
    owner: string,
    slug: string,
    versionNumber: number,
  ): Promise<GetPublicStackVersionResponse>;
  getPublicProfile(owner: string): Promise<PublicProfileResponse | null>;
  publishPublicStackVersion(
    slug: string,
    request: PublishPublicStackVersionRequest,
  ): Promise<PublishPublicStackVersionResponse>;
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
    redirect: 'error';
    signal: AbortSignal;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type CreateCloudClientOptions = {
  baseUrl: string;
  token?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  allowInsecure?: boolean;
};

const isLocalhost = (url: URL) =>
  url.hostname === 'localhost' ||
  url.hostname === '127.0.0.1' ||
  url.hostname === '::1' ||
  url.hostname.endsWith('.localhost');

export const createCloudClient = (
  options: CreateCloudClientOptions,
): CloudClient & CloudAuthClient & PublicStackClient & CloudMemoryClient => {
  const base = options.baseUrl.replace(/\/+$/, '');
  const parsedBase = new URL(base);
  if (
    parsedBase.protocol !== 'https:' &&
    !options.allowInsecure &&
    !isLocalhost(parsedBase)
  )
    throw new StackCloudError(
      'insecure-cloud-url',
      'STAK Cloud requires HTTPS outside local development.',
    );
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fetchImpl =
    options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl)
    throw new StackCloudError(
      'no-fetch',
      'No fetch implementation is available in this runtime.',
    );

  const request = async (
    method: string,
    apiPath: string,
    init: { auth: boolean; json?: unknown; bytes?: Uint8Array; raw?: boolean },
  ): Promise<{
    status: number;
    contentType: string;
    text: string;
    bytes: Uint8Array;
  }> => {
    if (init.auth && !options.token) throw new NotAuthenticatedError();
    const headers: Record<string, string> = { accept: '*/*' };
    if (init.auth && options.token)
      headers.authorization = `Bearer ${options.token}`;
    let body: string | Uint8Array | undefined;
    if (init.bytes !== undefined) {
      headers['content-type'] = 'application/octet-stream';
      body = init.bytes;
    } else if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${base}/api/v1/${apiPath}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      throw new CloudUnavailableError('Could not reach STAK Cloud.', {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (init.raw) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.status >= 400)
        throw cloudErrorFromResponse(
          response.status,
          undefined,
          `Cloud request failed (${response.status}).`,
        );
      return { status: response.status, contentType, text: '', bytes };
    }
    const text = await response.text();
    if (response.status >= 400) {
      let code: string | undefined;
      let message = `Cloud request failed (${response.status}).`;
      if (contentType.includes('application/json'))
        try {
          const parsed = JSON.parse(text) as {
            error?: { code?: string; message?: string };
          };
          code = parsed.error?.code;
          if (parsed.error?.message) message = parsed.error.message;
        } catch {
          /* fall through with default message */
        }
      throw cloudErrorFromResponse(response.status, code, message);
    }
    return {
      status: response.status,
      contentType,
      text,
      bytes: new Uint8Array(),
    };
  };

  const json = <T>(
    schema: { parse(value: unknown): T },
    payload: { contentType: string; text: string },
  ): T => {
    if (!payload.contentType.includes('application/json'))
      throw new StackCloudError(
        'invalid-response',
        'STAK Cloud returned a non-JSON response.',
      );
    return schema.parse(JSON.parse(payload.text));
  };

  return {
    ...createMemoryClientMethods({ request, json }),
    authStart: async (body) =>
      json(
        cliAuthStartResponseSchema,
        await request('POST', 'cli/auth/start', { auth: false, json: body }),
      ),
    authToken: async (body) =>
      json(
        cliAuthTokenResponseSchema,
        await request('POST', 'cli/auth/token', { auth: false, json: body }),
      ),
    authRevoke: async () => {
      await request('POST', 'cli/auth/revoke', { auth: true, json: {} });
    },
    me: async () =>
      json(meResponseSchema, await request('GET', 'me', { auth: true })),
    machineCheckin: async (body) =>
      json(
        machineCheckinResponseSchema,
        await request('POST', 'machines/checkin', { auth: true, json: body }),
      ),
    listMachines: async () =>
      json(
        listMachinesResponseSchema,
        await request('GET', 'machines', { auth: true }),
      ),
    syncProjects: async (body) =>
      json(
        syncProjectsResponseSchema,
        await request('POST', 'projects/sync', { auth: true, json: body }),
      ),
    setProjectLifecycle: async (projectId, lifecycle) =>
      json(
        setProjectLifecycleResponseSchema,
        await request(
          'POST',
          `projects/${encodeURIComponent(projectId)}/lifecycle`,
          {
            auth: true,
            json: { lifecycle },
          },
        ),
      ),
    getEnvironment: async (name) => {
      try {
        return json(
          getEnvironmentResponseSchema,
          await request('GET', `environments/${encodeURIComponent(name)}`, {
            auth: true,
          }),
        );
      } catch (error) {
        if (
          error instanceof StackCloudError &&
          error.code === 'remote-environment-not-found'
        )
          return null;
        throw error;
      }
    },
    commitEnvironmentVersion: async (name, body) =>
      json(
        commitEnvironmentVersionResponseSchema,
        await request(
          'POST',
          `environments/${encodeURIComponent(name)}/versions`,
          { auth: true, json: body },
        ),
      ),
    prepareSnapshot: async (body) =>
      json(
        prepareSnapshotResponseSchema,
        await request('POST', 'snapshots/prepare', { auth: true, json: body }),
      ),
    uploadSnapshot: async (uploadTicket, bytes) => {
      await request(
        'PUT',
        `snapshots/upload/${encodeURIComponent(uploadTicket)}`,
        { auth: true, bytes },
      );
    },
    finalizeSnapshot: async (body) =>
      json(
        finalizeSnapshotResponseSchema,
        await request('POST', 'snapshots/finalize', { auth: true, json: body }),
      ),
    downloadSnapshot: async (contentHash) => {
      const meta = json(
        snapshotDownloadResponseSchema,
        await request(
          'GET',
          `snapshots/${encodeURIComponent(contentHash)}/download`,
          { auth: true },
        ),
      );
      const blob = await request(
        'GET',
        `snapshots/blob/${encodeURIComponent(meta.downloadTicket)}`,
        { auth: true, raw: true },
      );
      if (blob.bytes.length !== meta.byteSize)
        throw new SnapshotDownloadFailedError(
          `Downloaded snapshot byte size mismatch for ${contentHash}.`,
        );
      return {
        contentHash,
        archiveHash: meta.archiveHash,
        byteSize: meta.byteSize,
        bytes: blob.bytes,
      };
    },
    getPublicStack: async (owner, slug) => {
      try {
        return json(
          getPublicStackResponseSchema,
          await request(
            'GET',
            `stacks/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`,
            { auth: false },
          ),
        );
      } catch (error) {
        if (
          error instanceof StackCloudError &&
          error.code === 'public-stack-not-found'
        )
          return null;
        throw error;
      }
    },
    getPublicStackVersion: async (owner, slug, versionNumber) =>
      json(
        getPublicStackVersionResponseSchema,
        await request(
          'GET',
          `stacks/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/versions/${versionNumber}`,
          { auth: false },
        ),
      ),
    getPublicProfile: async (owner) => {
      try {
        return json(
          publicProfileResponseSchema,
          await request('GET', `profiles/${encodeURIComponent(owner)}`, {
            auth: false,
          }),
        );
      } catch (error) {
        if (
          error instanceof StackCloudError &&
          error.code === 'public-stack-not-found'
        )
          return null;
        throw error;
      }
    },
    publishPublicStackVersion: async (slug, body) =>
      json(
        publishPublicStackVersionResponseSchema,
        await request('POST', `stacks/${encodeURIComponent(slug)}/versions`, {
          auth: true,
          json: body,
        }),
      ),
  };
};
