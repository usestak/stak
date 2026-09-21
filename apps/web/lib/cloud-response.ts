import { NextResponse } from 'next/server';

import type { CloudResponse } from '@stack/cloud-server';

/**
 * HTTP statuses that must never carry a response body (RFC 9110 §6.4.1 /
 * §15.3.5 / §15.4.5). Constructing a body for one of these is illegal and throws
 * in the Web/undici `Response` constructor — which is what turned a successful
 * `204 No Content` snapshot upload into a `500`.
 */
export const BODYLESS_STATUSES = new Set([204, 205, 304]);

/**
 * Whether a {@link CloudResponse} must be rendered without a body: either its
 * status forbids one, or the Cloud service emitted no json/binary payload (an
 * undefined `jsonBody` intentionally represents "no body", not `{}`).
 */
export const isBodylessCloudResponse = (response: CloudResponse): boolean =>
  BODYLESS_STATUSES.has(response.status) ||
  (response.binaryBody === undefined && response.jsonBody === undefined);

/**
 * Render a framework-agnostic {@link CloudResponse} as a Next.js response,
 * preserving body semantics: binary bodies pass through, bodyless responses stay
 * genuinely bodyless, and JSON is serialized only for statuses that allow a body.
 * Headers from the Cloud service are always preserved verbatim.
 */
export const renderCloudResponse = (response: CloudResponse): NextResponse => {
  if (response.binaryBody)
    return new NextResponse(Buffer.from(response.binaryBody), {
      status: response.status,
      headers: response.headers,
    });
  if (isBodylessCloudResponse(response))
    return new NextResponse(null, {
      status: response.status,
      headers: response.headers,
    });
  return NextResponse.json(response.jsonBody, {
    status: response.status,
    headers: response.headers,
  });
};
