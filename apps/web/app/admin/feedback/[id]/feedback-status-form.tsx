'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const STATUSES = ['new', 'reviewing', 'resolved', 'archived'] as const;

export function FeedbackStatusForm({
  feedbackId,
  initialStatus,
  initialAdminNote,
}: {
  feedbackId: string;
  initialStatus: string;
  initialAdminNote: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [adminNote, setAdminNote] = useState(initialAdminNote);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      // Only send `status` when it actually changed from what the record
      // already has -- otherwise a note-only edit on an already-resolved
      // item would re-send status:'resolved' every time, and the route
      // would re-stamp resolved_at/resolved_by to "now" on every save
      // instead of preserving the original resolution time/resolver.
      const body: { status?: string; adminNote: string } = { adminNote };
      if (status !== initialStatus) body.status = status;

      const res = await fetch(`/api/admin/feedback/${feedbackId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh(); // the server-rendered Status/admin_note above this form is otherwise stale
      } else {
        const payload = await res.json().catch(() => null);
        setError(typeof payload?.error === 'string' ? payload.error : `Save failed (${res.status}).`);
      }
    } catch {
      setError('Save failed — check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2>Admin workflow</h2>
      <label>
        Status
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setSaved(false);
          }}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label>
        Admin note
        <textarea
          value={adminNote}
          onChange={(e) => {
            setAdminNote(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      <button onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      {saved ? <p>Saved.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
