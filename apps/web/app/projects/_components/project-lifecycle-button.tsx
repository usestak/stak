'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { setProjectLifecycleAction } from '../actions';

export function ProjectLifecycleButton({
  projectId,
  lifecycle,
}: {
  projectId: string;
  lifecycle: 'active' | 'archived';
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const next = lifecycle === 'active' ? 'archived' : 'active';
    const result = await setProjectLifecycleAction({ projectId, lifecycle: next });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
      <button
        type="button"
        className="stak-pill"
        onClick={toggle}
        disabled={pending}
        aria-label={lifecycle === 'active' ? 'Archive this Project' : 'Unarchive this Project'}
      >
        {pending ? '…' : lifecycle === 'active' ? 'Archive' : 'Unarchive'}
      </button>
      <span role="status" aria-live="polite" style={{ fontSize: 12.5, color: error ? '#e5776a' : 'transparent' }}>
        {error ?? ''}
      </span>
    </div>
  );
}
