import { describe, expect, it } from 'vitest';

import type { CloudResponse } from '@stack/cloud-server';

import {
  BODYLESS_STATUSES,
  isBodylessCloudResponse,
  renderCloudResponse,
} from './cloud-response.js';

describe('renderCloudResponse', () => {
  it('renders a 204 upload success with zero response body', async () => {
    // Exactly what the snapshot upload handler returns.
    const response: CloudResponse = { status: 204, headers: {} };
    const rendered = renderCloudResponse(response);
    expect(rendered.status).toBe(204);
    expect(await rendered.text()).toBe('');
  });

  it('does not use JSON semantics for a 204 (no invented body or json content-type)', async () => {
    const rendered = renderCloudResponse({ status: 204, headers: {} });
    expect(isBodylessCloudResponse({ status: 204, headers: {} })).toBe(true);
    expect(await rendered.text()).toBe('');
    // NextResponse.json would have stamped a JSON content-type; we must not.
    expect(rendered.headers.get('content-type')).toBeNull();
  });

  it('never throws (500) when rendering a bodyless upload success', () => {
    // Regression: NextResponse.json({}, { status: 204 }) threw and became a 500.
    expect(() =>
      renderCloudResponse({ status: 204, headers: {} }),
    ).not.toThrow();
    expect(renderCloudResponse({ status: 204, headers: {} }).status).toBe(204);
  });

  it('serializes a normal 200 JSON response', async () => {
    const rendered = renderCloudResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      jsonBody: { ok: true, value: 42 },
    });
    expect(rendered.status).toBe(200);
    expect(await rendered.json()).toEqual({ ok: true, value: 42 });
  });

  it('serializes a 201 JSON response', async () => {
    const rendered = renderCloudResponse({
      status: 201,
      headers: { 'content-type': 'application/json' },
      jsonBody: { created: true },
    });
    expect(rendered.status).toBe(201);
    expect(await rendered.json()).toEqual({ created: true });
  });

  it('leaves error JSON responses unchanged', async () => {
    const rendered = renderCloudResponse({
      status: 404,
      headers: { 'content-type': 'application/json' },
      jsonBody: { error: { code: 'not-found', message: 'nope' } },
    });
    expect(rendered.status).toBe(404);
    expect(await rendered.json()).toEqual({
      error: { code: 'not-found', message: 'nope' },
    });
  });

  it('preserves headers from the CloudResponse', () => {
    const rendered = renderCloudResponse({
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'abc123' },
      jsonBody: {},
    });
    expect(rendered.headers.get('x-request-id')).toBe('abc123');
  });

  it('passes binary bodies through unchanged', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const rendered = renderCloudResponse({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      binaryBody: bytes,
    });
    expect(rendered.status).toBe(200);
    expect([...new Uint8Array(await rendered.arrayBuffer())]).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it.each([204, 205, 304])(
    'renders %i as a bodyless response',
    async (status) => {
      expect(BODYLESS_STATUSES.has(status)).toBe(true);
      const rendered = renderCloudResponse({ status, headers: {} });
      expect(rendered.status).toBe(status);
      expect(await rendered.text()).toBe('');
    },
  );

  it('treats an undefined jsonBody as bodyless rather than inventing {}', async () => {
    const rendered = renderCloudResponse({ status: 200, headers: {} });
    expect(await rendered.text()).toBe('');
  });
});
