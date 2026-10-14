'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { InlineCommand } from '../../_components/inline-command';
import { revokeMachineAction } from '../actions';

/**
 * Inline revoke confirmation (contract §12) — never a browser `confirm()`. Explains what
 * revocation actually does (stops this machine's token; Skills/Projects/Memory stay) before
 * the second click, and warns explicitly when this is the account's only active machine
 * (contract §13 — the backend permits it; the UI must make the consequence unmistakable).
 */
export function RevokeMachineButton({
  machineId,
  machineName,
  isOnlyActiveMachine,
}: {
  machineId: string;
  machineName: string;
  isOnlyActiveMachine: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!confirming)
    return (
      <button
        type="button"
        className="stak-pill"
        onClick={() => setConfirming(true)}
      >
        Revoke
      </button>
    );

  const confirm = async () => {
    setPending(true);
    setError(null);
    const result = await revokeMachineAction({ machineId });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  };

  return (
    <div className="stak-revoke-confirm">
      <p>
        {machineName} will no longer be able to authenticate with its bound
        token. Its history stays; Cloud Memory, Skills and Projects are
        untouched; local files on {machineName} are untouched.
      </p>
      {isOnlyActiveMachine ? (
        <p className="stak-revoke-warn">
          This is your only active machine. After revoking, nothing can check in
          or back up Memory until you approve a new machine with{' '}
          <InlineCommand command="stak login" />.
        </p>
      ) : null}
      <div className="stak-revoke-actions">
        <button
          type="button"
          className="stak-pill stak-pill-danger"
          onClick={confirm}
          disabled={pending}
        >
          {pending ? 'Revoking…' : `Confirm revoke ${machineName}`}
        </button>
        <button
          type="button"
          className="stak-pill"
          onClick={() => setConfirming(false)}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
      {error ? (
        <span role="status" aria-live="polite" className="stak-revoke-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
