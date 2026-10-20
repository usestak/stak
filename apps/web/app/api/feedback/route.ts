import { feedbackRequestSchema } from '@stack/spec';

import { getSessionUser } from '../../../lib/session';
import { serviceClient } from '../../../lib/supabase';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid-json' }, { status: 400 });
  }

  const parsed = feedbackRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid-body' }, { status: 400 });
  }

  const user = await getSessionUser();
  const { type, message, goal, email, pageUrl } = parsed.data;

  const { error } = await serviceClient()
    .from('feedback')
    .insert({
      type,
      message,
      goal: goal ?? null,
      email: email ?? null,
      page_url: pageUrl ?? null,
      user_id: user?.id ?? null,
      user_agent: request.headers.get('user-agent'),
      app_version: 'web',
    });

  if (error) {
    return Response.json(
      { ok: false, error: 'storage-failed' },
      { status: 500 },
    );
  }

  return Response.json({ ok: true }, { status: 202 });
}
