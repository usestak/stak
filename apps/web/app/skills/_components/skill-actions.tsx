'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { approveSkillVersionAction, setSkillPausedAction } from '../actions';

export function SkillActions({
  skillId,
  paused,
  updateAvailable,
  reviewArtifactId,
  approvedVersionShort,
}: {
  skillId: string;
  paused: boolean;
  updateAvailable: boolean;
  reviewArtifactId?: string;
  approvedVersionShort: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<'approve' | 'pause' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const approve = async () => {
    if (!reviewArtifactId || pending) return;
    setPending('approve');
    setError(null);
    setStale(false);
    const result = await approveSkillVersionAction({
      skillId,
      reviewArtifactId,
    });
    setPending(null);
    if (!result.ok) {
      setError(result.error);
      setStale(result.stale === true);
      return;
    }
    router.refresh();
  };

  const togglePause = async () => {
    if (pending) return;
    setPending('pause');
    setError(null);
    const result = await setSkillPausedAction({ skillId, paused: !paused });
    setPending(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        alignItems: 'flex-start',
      }}
    >
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="stak-pill"
          onClick={togglePause}
          disabled={pending !== null}
        >
          {pending === 'pause' ? '…' : paused ? 'Resume' : 'Pause'}
        </button>
        {updateAvailable ? (
          <button
            type="button"
            className="stak-approve"
            onClick={approve}
            disabled={pending !== null || !reviewArtifactId}
            aria-label="Approve this update"
            title={
              !reviewArtifactId
                ? "This update exceeds STAK's V0 review limits and can't be approved from the browser yet"
                : undefined
            }
          >
            {pending === 'approve'
              ? 'Approving…'
              : `Approve ${approvedVersionShort}→new`}
          </button>
        ) : null}
      </div>
      {updateAvailable && !reviewArtifactId ? (
        <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>
          This update exceeds STAK&apos;s V0 review limits and can&apos;t be
          approved from the browser yet.
        </span>
      ) : null}
      <span
        role="status"
        aria-live="polite"
        style={{ fontSize: 12.5, color: error ? '#e5776a' : 'transparent' }}
      >
        {error
          ? stale
            ? `${error} Reload to review the latest candidate.`
            : error
          : ''}
      </span>
    </div>
  );
}
