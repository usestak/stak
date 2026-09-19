import { handleCloudRequest, type CloudRequest } from './handler.js';
import type { CloudService } from './service.js';

type FetchInit = {
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
};
type FetchResponse = {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

/**
 * A `fetch`-compatible function that dispatches straight into the Cloud router,
 * so the real HTTP client can exercise the exact request/response contract with
 * no network. Used by tests and the fenced two-Machine demonstration.
 */
export const createInProcessFetch = (
  service: CloudService,
): ((input: string, init: FetchInit) => Promise<FetchResponse>) => {
  return async (input, init) => {
    const url = new URL(input);
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(init.headers ?? {}))
      headers[name.toLowerCase()] = value;

    const cloudRequest: CloudRequest = {
      method: init.method,
      path: url.pathname,
      headers,
    };
    if (init.body instanceof Uint8Array) cloudRequest.binaryBody = init.body;
    else if (typeof init.body === 'string' && init.body.length > 0)
      cloudRequest.jsonBody = JSON.parse(init.body);

    const response = await handleCloudRequest(service, cloudRequest);
    const contentType = response.headers['content-type'] ?? null;
    return {
      status: response.status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? contentType : null,
      },
      text: async () =>
        response.jsonBody === undefined
          ? ''
          : JSON.stringify(response.jsonBody),
      arrayBuffer: async () => {
        const body = response.binaryBody ?? new Uint8Array();
        return body.buffer.slice(
          body.byteOffset,
          body.byteOffset + body.byteLength,
        ) as ArrayBuffer;
      },
    };
  };
};
