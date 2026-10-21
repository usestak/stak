import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';

const VALID_STATUSES = ['new', 'reviewing', 'resolved', 'archived'] as const;
type Status = (typeof VALID_STATUSES)[number];
const isValidStatus = (value: unknown): value is Status =>
  typeof value === 'string' && (VALID_STATUSES as readonly string[]).includes(value);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const admin = await getAdminUser();
  if (!admin) return Response.json({ ok: false, error: 'not-found' }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid-json' }, { status: 400 });
  }

  const { status, adminNote } = (body ?? {}) as { status?: unknown; adminNote?: unknown };

  if (status !== undefined && !isValidStatus(status)) {
    return Response.json({ ok: false, error: 'invalid-status' }, { status: 400 });
  }
  if (adminNote !== undefined && typeof adminNote !== 'string') {
    return Response.json({ ok: false, error: 'invalid-admin-note' }, { status: 400 });
  }

  const fields: Record<string, unknown> = {};
  if (status !== undefined) {
    fields.status = status;
    if (status === 'resolved') {
      fields.resolved_at = new Date().toISOString();
      fields.resolved_by = admin.id;
    }
  }
  if (adminNote !== undefined) fields.admin_note = adminNote;

  const { id } = await params;
  const { error } = await serviceClient().from('feedback').update(fields).eq('id', id);

  if (error) {
    console.error('[api/admin/feedback] update failed:', error.code, error.message);
    return Response.json({ ok: false, error: 'storage-failed' }, { status: 500 });
  }

  return Response.json({ ok: true }, { status: 200 });
}
