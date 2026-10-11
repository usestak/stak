'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { SkillShareStatus } from '@stack/spec';

import { shareSkillAction } from '../actions';

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

  if (share.status === 'already-shared' || sharedUrl) {
    const resolvedUrl =
      sharedUrl ?? (share.status === 'already-shared' ? share.url : '');
    return (
      <section
        style={{ display: 'flex', flexDirection: 'column', gap: 5 }}
        aria-label="Sharing"
      >
        <h2>Sharing</h2>
        <span style={{ fontSize: 13 }}>Already shared</span>
        <a
          href={resolvedUrl}
          style={{ fontSize: 12.5, fontFamily: 'var(--mono)' }}
        >
          {resolvedUrl}
        </a>
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
