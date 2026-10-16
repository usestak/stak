'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { SkillShareStatus } from '@stack/spec';

import { emitSync } from '../../../lib/sync/stak-sync';
import { shareSkillAction, unshareSkillAction } from '../actions';

/**
 * Sharing section for `/skills/[skillId]` (spec §5): three explicit, pre-computed states —
 * never a generic "Share" button that can fail after the click, because `share`'s status is
 * resolved server-side (`getSkillShareStatus`) before this ever renders.
 */
export function SkillShareSection({
  skillId,
  share,
}: {
  skillId: string;
  share: SkillShareStatus;
}) {
  const router = useRouter();
  const [slug, setSlug] = useState(
    share.status === 'shareable' ? share.suggestedSlug : '',
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharedUrl, setSharedUrl] = useState<string | null>(null);
  const [confirmingUnshare, setConfirmingUnshare] = useState(false);
  const [unshared, setUnshared] = useState(false);

  const unshare = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await unshareSkillAction(skillId);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setConfirmingUnshare(false);
    setUnshared(true);
    emitSync(['skills', 'sidebar']);
    router.refresh();
  };

  if (
    !unshared &&
    (share.status === 'already-shared' ||
      share.status === 'update-available' ||
      sharedUrl)
  ) {
    const resolvedUrl =
      sharedUrl ??
      (share.status === 'already-shared' || share.status === 'update-available'
        ? share.url
        : '');
    // sharedUrl means we just updated it in this session — re-rendering with a fresh
    // router.refresh() will re-resolve status server-side, but show the up-to-date state
    // immediately rather than a stale "update available" until that refresh lands.
    const showUpdateAvailable =
      !sharedUrl && share.status === 'update-available';
    const updateNow = async () => {
      if (pending || share.status !== 'update-available') return;
      setPending(true);
      setError(null);
      const result = await shareSkillAction({ skillId, slug: share.slug });
      setPending(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSharedUrl(result.url);
      emitSync(['skills', 'sidebar']);
      router.refresh();
    };
    return (
      <section
        style={{ display: 'flex', flexDirection: 'column', gap: 5 }}
        aria-label="Sharing"
      >
        <h2>Sharing</h2>
        <span style={{ fontSize: 13 }}>
          {showUpdateAvailable
            ? 'Update available to the shared version'
            : 'Shared'}
        </span>
        <a
          href={resolvedUrl}
          style={{ fontSize: 12.5, fontFamily: 'var(--mono)' }}
        >
          {resolvedUrl}
        </a>
        {showUpdateAvailable && (
          <>
            <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
              The approved Skill has a newer revision than what's published.
            </span>
            <button
              type="button"
              className="stak-pill"
              onClick={updateNow}
              disabled={pending}
              style={{ alignSelf: 'flex-start' }}
            >
              {pending ? 'Updating…' : 'Update shared version'}
            </button>
          </>
        )}
        {confirmingUnshare ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
              Stop sharing this Skill? The public link will stop working. Your
              Skill and its history stay unchanged.
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="stak-pill"
                onClick={unshare}
                disabled={pending}
              >
                {pending ? 'Stopping…' : 'Stop sharing'}
              </button>
              <button
                type="button"
                className="stak-pill"
                onClick={() => setConfirmingUnshare(false)}
                disabled={pending}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="stak-pill"
            onClick={() => setConfirmingUnshare(true)}
            style={{ alignSelf: 'flex-start' }}
          >
            Unshare
          </button>
        )}
        <span
          role="status"
          aria-live="polite"
          style={{ fontSize: 12.5, color: error ? '#e5776a' : 'transparent' }}
        >
          {error ?? ''}
        </span>
      </section>
    );
  }

  if (share.status === 'not-shareable')
    return (
      <section
        style={{ display: 'flex', flexDirection: 'column', gap: 5 }}
        aria-label="Sharing"
      >
        <h2>Sharing</h2>
        <span style={{ fontSize: 13 }}>Not shareable from this source</span>
        <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
          {share.reason}
        </span>
      </section>
    );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await shareSkillAction({ skillId, slug });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSharedUrl(result.url);
    emitSync(['skills', 'sidebar']);
    router.refresh();
  };

  return (
    <section
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      aria-label="Sharing"
    >
      <h2>Sharing</h2>
      <span style={{ fontSize: 13 }}>Shareable</span>
      <form
        onSubmit={submit}
        style={{ display: 'flex', gap: 8, alignItems: 'center' }}
      >
        <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>@you/</span>
        <input
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          aria-label="Public slug"
          style={{ fontFamily: 'var(--mono)', fontSize: 13 }}
          required
          pattern="[a-z0-9][a-z0-9-_]{0,62}"
        />
        <button type="submit" className="stak-pill" disabled={pending}>
          {pending ? 'Sharing…' : 'Share'}
        </button>
      </form>
      <span
        role="status"
        aria-live="polite"
        style={{ fontSize: 12.5, color: error ? '#e5776a' : 'transparent' }}
      >
        {error ?? ''}
      </span>
    </section>
  );
}
