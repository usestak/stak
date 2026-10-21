'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import type {
  GetUserStackPublicationStatusResponse,
  UserStackDetail,
} from '@stack/spec';

import { emitSync } from '../../../lib/sync/stak-sync';
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
 * `/staks/[stackId]` — add Skill, remove Skill, pause/resume within the Stack, rename,
 * review, save (P10B §12-13). Saving always goes through a single `updateUserStack` call
 * that commits a brand-new immutable version — never an in-place edit, and `main` is never
 * touched (verified server-side in cloud-server's user-stack-service.test.ts).
 */
export function EditStakForm({
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
  const [description, setDescription] = useState(detail.description);
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
  // Default detail view is a VIEW, not a permanently-open editor (web UX simplification):
  // `editing` reveals the name/description/Skill-selector form on demand; `reviewing` is a
  // sub-step of editing. Creation already chose the composition once — this page's default
  // state should show it, not ask the user to reconfigure it before they can publish.
  const [editing, setEditing] = useState(false);
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
  // `useState(initialPublication)` only consults the prop on the FIRST render — React
  // preserves this component's state across every later re-render of the same mounted
  // instance, including the one `router.refresh()` triggers after a Realtime/BroadcastChannel
  // invalidation. Without this, a server-confirmed publish/unpublish/republish only reaches
  // the Publish section after a full page reload, even though `detail.description`/
  // `detail.skills` above already update correctly (they read the `detail` prop directly,
  // not a copy in state). `publish`/`unpublish` still set `publication` optimistically from
  // their own authoritative server response before this effect's prop ever changes, so this
  // sync only overwrites it once the server's own refreshed props agree — never fabricates
  // state, never loops (the effect only reruns when the prop reference actually changes).
  useEffect(() => {
    setPublication(initialPublication);
  }, [initialPublication]);
  const [publishing, setPublishing] = useState(false);
  // Only a published (or legacy/republishable) status actually carries a slug — `private`
  // and `upload-required` intentionally don't, so any other status falls back to the
  // Stack's current name as a safe unpublished default.
  const [publishSlug, setPublishSlug] = useState(
    initialPublication.status === 'published' ||
      initialPublication.status === 'changed-since-published' ||
      initialPublication.status === 'portable-republish-needed'
      ? initialPublication.slug
      : detail.name,
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
      ...(description.trim() !== detail.description
        ? { description: description.trim() }
        : {}),
      skills: included.map((r) => ({ skillId: r.skillId, paused: r.paused })),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaved(result.versionNumber);
    setReviewing(false);
    setEditing(false);
    emitSync(['staks', 'sidebar', 'overview']);
    router.refresh();
  };

  const cancelEdit = () => {
    setName(detail.name);
    setDescription(detail.description);
    setRows((prev) => {
      const inStack = new Map(
        detail.skills.map((s) => [s.skillId, s.paused === true]),
      );
      return prev.map((r) => ({
        ...r,
        inStack: inStack.has(r.skillId),
        paused: inStack.get(r.skillId) ?? false,
      }));
    });
    setError(null);
    setEditing(false);
  };

  const publish = async () => {
    if (publishing) return;
    setPublishing(true);
    setPublishError(null);
    const result = await publishUserStackAction({
      stackId: detail.stackId,
      slug: publishSlug.trim(),
      description: description.trim(),
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
    emitSync(['staks', 'publication', 'sidebar', 'overview']);
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
    emitSync(['staks', 'publication', 'sidebar', 'overview']);
    router.refresh();
  };

  if (reviewing)
    return (
      <div className="stak-stack-form-step">
        <span style={{ fontSize: 13 }}>
          Review changes to <strong>{name}</strong>
        </span>
        {description ? (
          <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
            {description}
          </span>
        ) : null}
        <div style={{ border: '1px solid var(--line-2)', borderRadius: 8 }}>
          {included.length === 0 ? (
            <p style={{ padding: 14, fontSize: 13, color: 'var(--faint)' }}>
              This STAK would have no Skills.
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

  if (!editing)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        <section className="stak-stack-form-step" aria-label="STAK composition">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>Description</span>
            <span style={{ fontSize: 13, color: 'var(--faint)' }}>
              {detail.description || 'No description.'}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>
              Skills ({detail.skills.length})
            </span>
            {detail.skills.length === 0 ? (
              <span style={{ fontSize: 13, color: 'var(--faint)' }}>
                This STAK has no Skills.
              </span>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {detail.skills.map((s) => (
                  <li
                    key={s.skillId}
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      padding: '4px 0',
                      fontSize: 13,
                    }}
                  >
                    <span style={{ fontFamily: 'var(--mono)' }}>{s.name}</span>
                    {s.paused ? (
                      <span style={{ color: 'var(--faint)' }}>Paused</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <button
              type="button"
              className="stak-pill"
              style={{ cursor: 'pointer' }}
              onClick={() => setEditing(true)}
            >
              Edit STAK
            </button>
            {saved !== null ? (
              <span
                style={{
                  marginLeft: 12,
                  fontSize: 12.5,
                  color: 'var(--faint)',
                }}
              >
                Saved as version {saved}.
              </span>
            ) : null}
          </div>
        </section>
        <PublishSection
          publication={publication}
          publishSlug={publishSlug}
          setPublishSlug={setPublishSlug}
          description={description}
          setDescription={setDescription}
          publish={publish}
          publishing={publishing}
          publishError={publishError}
          confirmingUnpublish={confirmingUnpublish}
          setConfirmingUnpublish={setConfirmingUnpublish}
          unpublish={unpublish}
        />
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

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            Description <span style={{ color: 'var(--dim)' }}>(optional)</span>
          </span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this STAK is for"
            style={{
              fontSize: 13,
              padding: '8px 10px',
              border: '1px solid var(--chip)',
              borderRadius: 6,
              background: '#151413',
              color: 'var(--ink)',
              maxWidth: 420,
            }}
          />
        </label>

        <div
          className="stak-stack-form-picker"
          role="group"
          aria-label="Skills in this STAK"
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
                  {r.paused ? 'Resume in STAK' : 'Pause in STAK'}
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            className="stak-pill"
            style={{ cursor: 'pointer' }}
            disabled={name.trim().length === 0}
            onClick={() => setReviewing(true)}
          >
            Review changes
          </button>
          <button
            type="button"
            className="stak-pill"
            style={{ cursor: 'pointer' }}
            onClick={cancelEdit}
          >
            Cancel
          </button>
          {saved !== null ? (
            <span
              style={{
                marginLeft: 2,
                alignSelf: 'center',
                fontSize: 12.5,
                color: 'var(--faint)',
              }}
            >
              Saved as version {saved}.
            </span>
          ) : null}
        </div>
      </section>

      <PublishSection
        publication={publication}
        publishSlug={publishSlug}
        setPublishSlug={setPublishSlug}
        description={description}
        setDescription={setDescription}
        publish={publish}
        publishing={publishing}
        publishError={publishError}
        confirmingUnpublish={confirmingUnpublish}
        setConfirmingUnpublish={setConfirmingUnpublish}
        unpublish={unpublish}
      />
    </div>
  );
}

function PublishSection({
  publication,
  publishSlug,
  setPublishSlug,
  description,
  setDescription,
  publish,
  publishing,
  publishError,
  confirmingUnpublish,
  setConfirmingUnpublish,
  unpublish,
}: {
  publication: Publication;
  publishSlug: string;
  setPublishSlug: (slug: string) => void;
  description: string;
  setDescription: (description: string) => void;
  publish: () => void;
  publishing: boolean;
  publishError: string | null;
  confirmingUnpublish: boolean;
  setConfirmingUnpublish: (value: boolean) => void;
  unpublish: () => void;
}) {
  const descriptionMissing = description.trim().length === 0;
  // Shared across first publish and every republish body below — a Stack can reach any of
  // those states with an empty description (e.g. edited blank after a prior publish), and
  // the server rejects an empty description at publish time (read-side parity: `stak use`/
  // `stak try` require a non-empty `stack.description`), so the fix belongs right here
  // rather than sending the user back to the composition form above to find it.
  const descriptionField = (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
        Description{' '}
        {descriptionMissing ? (
          <span style={{ color: '#e5776a' }}>(required to publish)</span>
        ) : null}
      </span>
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Add a description before publishing"
        aria-label="Description to publish"
        style={{
          fontSize: 13,
          padding: '8px 10px',
          border: '1px solid var(--chip)',
          borderRadius: 6,
          background: '#151413',
          color: 'var(--ink)',
          maxWidth: 420,
        }}
      />
    </label>
  );
  const unpublishControl = confirmingUnpublish ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
        Stop publishing this STAK? The public link will stop working. Your saved
        STAK stays unchanged.
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
  );

  const publishForm = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {descriptionField}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>you/</span>
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
          disabled={publishing || descriptionMissing}
        >
          {publishing ? 'Publishing…' : 'Publish'}
        </button>
      </div>
    </div>
  );

  // Every publication status has deliberate UI behavior — no state falls through to a
  // generic "else" that might assume fields (slug/url/owner/versionNumber) a given status
  // doesn't carry. `private` and `upload-required` are the only two that legitimately don't.
  let body: ReactNode;
  switch (publication.status) {
    case 'private':
      body = publishForm;
      break;
    case 'upload-required':
      // No slug/url/owner/versionNumber on this status by design — this Skill's content
      // isn't fully in STAK Cloud yet, so publishing now is guaranteed to fail. Never render
      // an enabled Publish action for it.
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13 }}>Upload required</span>
          <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
            Run <code>stak push</code>, then try again.
          </span>
        </div>
      );
      break;
    case 'published':
    case 'changed-since-published':
      body = (
        <>
          <span style={{ fontSize: 13 }}>
            {publication.status === 'published'
              ? 'Published'
              : 'Unpublished changes'}
          </span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
            <a
              href={publication.url}
              style={{ fontSize: 12.5, fontFamily: 'var(--mono)' }}
            >
              {publication.url}
            </a>
            <a
              href={publication.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12.5 }}
            >
              Open public page
            </a>
          </div>
          {publication.status === 'changed-since-published' && (
            <>
              <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
                This STAK&apos;s saved composition no longer matches what&apos;s
                published.
              </span>
              {descriptionField}
              <button
                type="button"
                className="stak-pill"
                style={{ alignSelf: 'flex-start', cursor: 'pointer' }}
                onClick={publish}
                disabled={publishing || descriptionMissing}
              >
                {publishing ? 'Republishing…' : 'Republish'}
              </button>
            </>
          )}
          {unpublishControl}
        </>
      );
      break;
    case 'portable-republish-needed':
      // Legacy (pre-snapshot-first) publication — still readable/linkable, but republishing
      // produces a current, portable, snapshot-backed version. By the time status resolves
      // to this (rather than `upload-required`), the content needed to do that is already
      // available, so the Republish action here is never guaranteed to fail.
      body = (
        <>
          <span style={{ fontSize: 13 }}>Portable republish needed</span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
            <a
              href={publication.url}
              style={{ fontSize: 12.5, fontFamily: 'var(--mono)' }}
            >
              {publication.url}
            </a>
            <a
              href={publication.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12.5 }}
            >
              Open public page
            </a>
          </div>
          <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
            This STAK is still published in a legacy format. Republish to
            upgrade it to a portable snapshot.
          </span>
          {descriptionField}
          <button
            type="button"
            className="stak-pill"
            style={{ alignSelf: 'flex-start', cursor: 'pointer' }}
            onClick={publish}
            disabled={publishing || descriptionMissing}
          >
            {publishing ? 'Republishing…' : 'Republish'}
          </button>
          {unpublishControl}
        </>
      );
      break;
    default: {
      const exhaustive: never = publication;
      throw new Error(
        `Unhandled publication status: ${JSON.stringify(exhaustive)}`,
      );
    }
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 14 }}>Publish</h2>
      {body}
      <span style={{ fontSize: 12, color: 'var(--dim)', maxWidth: 480 }}>
        Publishing makes this STAK&apos;s current saved version public at a URL
        anyone can read — including the contents of any Local Skill in it,
        through an immutable content snapshot. Only publish content you have
        permission to share. If a Skill hasn&apos;t been pushed to Cloud yet,
        publishing fails for the whole STAK with a clear reason — it never
        publishes a partial composition.
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
  );
}
