import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';

const VALID_STATUSES = ['new', 'reviewing', 'resolved', 'archived'] as const;
type Status = (typeof VALID_STATUSES)[number];
const isValidStatus = (value: unknown): value is Status =>
  typeof value === 'string' &&
  (VALID_STATUSES as readonly string[]).includes(value);

// Matches the free-text cap already used elsewhere on this table
// (feedback.goal, migration 0012) -- admin_note has no DB-level check,
// so bound it here instead of leaving it unbounded.
const MAX_ADMIN_NOTE_LENGTH = 2000;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const admin = await getAdminUser();
  if (!admin)
    return Response.json({ ok: false, error: 'not-found' }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid-json' }, { status: 400 });
  }

  const { status, adminNote } = (body ?? {}) as {
    status?: unknown;
    adminNote?: unknown;
  };

  if (status !== undefined && !isValidStatus(status)) {
    return Response.json(
      { ok: false, error: 'invalid-status' },
      { status: 400 },
    );
  }
  if (adminNote !== undefined) {
    if (typeof adminNote !== 'string') {
      return Response.json(
        { ok: false, error: 'invalid-admin-note' },
        { status: 400 },
      );
    }
    if (adminNote.length > MAX_ADMIN_NOTE_LENGTH) {
      return Response.json(
        { ok: false, error: 'admin-note-too-long' },
        { status: 400 },
      );
    }
  }

  const fields: Record<string, unknown> = {};
  if (status !== undefined) {
    fields.status = status;
    // Only stamp resolved_at/resolved_by when actually transitioning TO
    // 'resolved'; clear them when moving away from it, so a status change
    // back to 'reviewing'/'new'/'archived' doesn't leave a stale
    // resolution record. The client (feedback-status-form.tsx) only sends
    // `status` when it actually changed, so a note-only save never reaches
    // this branch and never re-stamps an already-resolved item's fields.
    if (status === 'resolved') {
      fields.resolved_at = new Date().toISOString();
      fields.resolved_by = admin.id;
    } else {
      fields.resolved_at = null;
      fields.resolved_by = null;
    }
  }
  if (adminNote !== undefined) fields.admin_note = adminNote;

  if (Object.keys(fields).length === 0) {
    return Response.json({ ok: false, error: 'no-fields' }, { status: 400 });
  }

  const { id } = await params;

  try {
    const { data, error } = await serviceClient()
      .from('feedback')
      .update(fields)
      .eq('id', id)
      .select('id');

    if (error) {
      console.error(
        '[api/admin/feedback] update failed:',
        error.code,
        error.message,
      );
      return Response.json(
        { ok: false, error: 'storage-failed' },
        { status: 500 },
      );
    }
    if (!data || data.length === 0) {
      return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
    }
  } catch (err) {
    // Covers serviceClient()'s own throw (e.g. a missing/misconfigured
    // Supabase env var), same distinction the public feedback route makes.
    console.error('[api/admin/feedback] service client/config error:', err);
    return Response.json(
      { ok: false, error: 'storage-failed' },
      { status: 500 },
    );
  }

  return Response.json({ ok: true }, { status: 200 });
}
