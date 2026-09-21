import { type NextRequest } from 'next/server';

import { handleCloudRequest, type CloudRequest } from '@stack/cloud-server';

import { renderCloudResponse } from '@/lib/cloud-response';
import { getCloudService } from '@/lib/cloud-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const run = async (request: NextRequest): Promise<Response> => {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const cloudRequest: CloudRequest = {
    method: request.method,
    path: request.nextUrl.pathname,
    headers,
  };
  if (request.method === 'PUT')
    cloudRequest.binaryBody = new Uint8Array(await request.arrayBuffer());
  else if (request.method === 'POST')
    try {
      cloudRequest.jsonBody = await request.json();
    } catch {
      cloudRequest.jsonBody = {};
    }

  const response = await handleCloudRequest(getCloudService(), cloudRequest);
  return renderCloudResponse(response);
};

export const GET = run;
export const POST = run;
export const PUT = run;
