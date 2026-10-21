'use client';

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
  const [status, setStatus] = useState(initialStatus);
  const [adminNote, setAdminNote] = useState(initialAdminNote);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(`/api/admin/feedback/${feedbackId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status, adminNote }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2>Admin workflow</h2>
      <label>
        Status
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label>
        Admin note
        <textarea value={adminNote} onChange={(e) => setAdminNote(e.target.value)} />
      </label>
      <button onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      {saved ? <p>Saved.</p> : null}
    </div>
  );
}
