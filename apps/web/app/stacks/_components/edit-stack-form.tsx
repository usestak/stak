'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import type {
  GetUserStackPublicationStatusResponse,
  UserStackDetail,
} from '@stack/spec';

import {
  getUserStackPublicationStatusAction,
  publishUserStackAction,
  unpublishUserStackAction,
  updateUserStackAction,
} from '../actions';

type ApprovedSkill = { skillId: string; name: string; paused: boolean };

type Row = { skillId: string; name: string; inStack: boolean; paused: boolean };

type Publication = GetUserStackPublicationStatusResponse['publication'];

/**
 * `/stacks/[stackId]` — add Skill, remove Skill, pause/resume within the Stack, rename,
 * review, save (P10B §12-13). Saving always goes through a single `updateUserStack` call
 * that commits a brand-new immutable version — never an in-place edit, and `main` is never
 * touched (verified server-side in cloud-server's user-stack-service.test.ts).
 */
export function EditStackForm({
  detail,
  approvedSkills,
  initialPublication,
}: {
  detail: UserStackDetail;
  approvedSkills: ApprovedSkill[];
  initialPublication: Publication;
}) {
  const router = useRouter();
  const [name, setName] = useState(detail.name);
  const [rows, setRows] = useState<Row[]>(() => {
    const inStack = new Map(
      detail.skills.map((s) => [s.skillId, s.paused === true]),
    );
    return approvedSkills.map((s) => ({
      skillId: s.skillId,
      name: s.name,
      inStack: inStack.has(s.skillId),
      paused: inStack.get(s.skillId) ?? false,
    }));
  });
  const [reviewing, setReviewing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  // Server-resolved, not ephemeral (spec P10 correction §13): starts from what the page
  // loader actually fetched, and every publish/republish re-fetches it from the server so a
  // reload never shows a false "private" after a real publish, or a false "published" after
  // the source composition changed.
  const [publication, setPublication] =
    useState<Publication>(initialPublication);
  const [publishing, setPublishing] = useState(false);
  const [publishSlug, setPublishSlug] = useState(
    initialPublication.status === 'private'
      ? detail.name
      : initialPublication.slug,
  );
  const [publishError, setPublishError] = useState<string | null>(null);

  const included = useMemo(() => rows.filter((r) => r.inStack), [rows]);

  const toggleIncluded = (skillId: string) =>
    setRows((prev) =>
      prev.map((r) =>
        r.skillId === skillId ? { ...r, inStack: !r.inStack } : r,
      ),
    );
  const togglePaused = (skillId: string) =>
    setRows((prev) =>
      prev.map((r) =>
        r.skillId === skillId ? { ...r, paused: !r.paused } : r,
      ),
    );

  const save = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await updateUserStackAction({
      stackId: detail.stackId,
      expectedLatestVersionId: detail.version?.versionId ?? null,
      ...(name.trim() !== detail.name ? { name: name.trim() } : {}),
      skills: included.map((r) => ({ skillId: r.skillId, paused: r.paused })),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaved(result.versionNumber);
    setReviewing(false);
    router.refresh();
  };

  const publish = async () => {
    if (publishing) return;
    setPublishing(true);
    setPublishError(null);
    const result = await publishUserStackAction({
      stackId: detail.stackId,
      slug: publishSlug.trim(),
    });
    if (!result.ok) {
      setPublishing(false);
      setPublishError(result.error);
      return;
    }
    // Re-resolve from the server rather than constructing the new state locally — the
    // server is the single source of truth for whether the composition is now up to date.
    const status = await getUserStackPublicationStatusAction(detail.stackId);
    setPublishing(false);
    if (status.ok) setPublication(status.status);
    router.refresh();
  };

  const [confirmingUnpublish, setConfirmingUnpublish] = useState(false);
  const unpublish = async () => {
    if (publishing) return;
    setPublishing(true);
    setPublishError(null);
    const result = await unpublishUserStackAction(detail.stackId);
    setPublishing(false);
    if (!result.ok) {
      setPublishError(result.error);
      return;
    }
    setConfirmingUnpublish(false);
    setPublication({ status: 'private' });
    router.refresh();
  };

  if (reviewing)
    return (
      <div className="stak-stack-form-step">
        <span style={{ fontSize: 13 }}>
          Review changes to <strong>{name}</strong>
        </span>
        <div style={{ border: '1px solid var(--line-2)', borderRadius: 8 }}>
          {included.length === 0 ? (
            <p style={{ padding: 14, fontSize: 13, color: 'var(--faint)' }}>
              This Stack would have no Skills.
            </p>
          ) : (
            included.map((r) => (
              <div key={r.skillId} className="stak-stack-edit-row">
                <span style={{ fontFamily: 'var(--mono)' }}>{r.name}</span>
                <span
                  style={{ color: r.paused ? 'var(--faint)' : 'var(--ink)' }}
                >
                  {r.paused ? 'Paused' : 'Included'}
                </span>
                <span />
              </div>
            ))
          )}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            className="stak-pill"
            style={{ cursor: 'pointer' }}
            onClick={() => setReviewing(false)}
            disabled={pending}
          >
            Back
          </button>
          <button
            type="button"
            className="stak-pill"
            style={{ cursor: 'pointer' }}
            onClick={save}
            disabled={pending}
          >
            {pending ? 'Saving…' : 'Save as new version'}
          </button>
        </div>
        <span
          role="status"
          aria-live="polite"
          style={{ fontSize: 12.5, color: error ? '#e5776a' : 'transparent' }}
        >
          {error ?? ''}
        </span>
      </div>
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <section className="stak-stack-form-step">
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 13,
              padding: '8px 10px',
              border: '1px solid var(--chip)',
              borderRadius: 6,
              background: '#151413',
              color: 'var(--ink)',
              maxWidth: 320,
            }}
          />
        </label>

        <div
          className="stak-stack-form-picker"
          role="group"
          aria-label="Skills in this Stack"
        >
          {rows.map((r) => (
            <div key={r.skillId} className="stak-stack-form-picker-row">
              <input
                type="checkbox"
                checked={r.inStack}
                onChange={() => toggleIncluded(r.skillId)}
                aria-label={`Include ${r.name}`}
              />
              <span style={{ fontFamily: 'var(--mono)' }}>{r.name}</span>
              {r.inStack ? (
                <button
                  type="button"
                  className="stak-pill"
                  style={{
                    marginLeft: 'auto',
                    cursor: 'pointer',
                    padding: '3px 9px',
                  }}
                  onClick={() => togglePaused(r.skillId)}
                >
                  {r.paused ? 'Resume in Stack' : 'Pause in Stack'}
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <div>
          <button
            type="button"
            className="stak-pill"
            style={{ cursor: 'pointer' }}
            disabled={name.trim().length === 0}
            onClick={() => setReviewing(true)}
          >
            Review changes
          </button>
          {saved !== null ? (
            <span
              style={{ marginLeft: 12, fontSize: 12.5, color: 'var(--faint)' }}
            >
              Saved as version {saved}.
            </span>
          ) : null}
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 14 }}>Publish</h2>
        {publication.status === 'published' ||
        publication.status === 'changed-since-published' ? (
          <>
            <span style={{ fontSize: 13 }}>
              {publication.status === 'published'
                ? 'Published'
                : 'Changed since published'}
            </span>
            <a
              href={publication.url}
              style={{ fontSize: 12.5, fontFamily: 'var(--mono)' }}
            >
              {publication.url}
            </a>
            {publication.status === 'changed-since-published' && (
              <>
                <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
                  This Stack&apos;s composition has changed since that version
                  was published.
                </span>
                <button
                  type="button"
                  className="stak-pill"
                  style={{ alignSelf: 'flex-start', cursor: 'pointer' }}
                  onClick={publish}
                  disabled={publishing}
                >
                  {publishing ? 'Updating…' : 'Update published version'}
                </button>
              </>
            )}
            {confirmingUnpublish ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
                  Stop publishing this Stack? The public link will stop working.
                  Your saved Stack stays unchanged.
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="stak-pill"
                    onClick={unpublish}
                    disabled={publishing}
                  >
                    {publishing ? 'Stopping…' : 'Stop publishing'}
                  </button>
                  <button
                    type="button"
                    className="stak-pill"
                    onClick={() => setConfirmingUnpublish(false)}
                    disabled={publishing}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="stak-pill"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => setConfirmingUnpublish(true)}
              >
                Unpublish
              </button>
            )}
          </>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>@you/</span>
            <input
              value={publishSlug}
              onChange={(e) => setPublishSlug(e.target.value)}
              aria-label="Public slug"
              style={{ fontFamily: 'var(--mono)', fontSize: 13 }}
              pattern="[a-z0-9][a-z0-9-_]{0,62}"
            />
            <button
              type="button"
              className="stak-pill"
              style={{ cursor: 'pointer' }}
              onClick={publish}
              disabled={publishing}
            >
              {publishing ? 'Publishing…' : 'Publish'}
            </button>
          </div>
        )}
        <span style={{ fontSize: 12, color: 'var(--dim)', maxWidth: 480 }}>
          Publishing makes a reference-only copy of this Stack&apos;s current
          saved version public at a URL anyone can read. If any Skill in it
          can&apos;t be published (for example, a Local Skill with no Git
          origin), publishing fails for the whole Stack with a clear reason — it
          never publishes a partial composition.
        </span>
        <span
          role="status"
          aria-live="polite"
          style={{
            fontSize: 12.5,
            color: publishError ? '#e5776a' : 'transparent',
          }}
        >
          {publishError ?? ''}
        </span>
      </section>
    </div>
  );
}
