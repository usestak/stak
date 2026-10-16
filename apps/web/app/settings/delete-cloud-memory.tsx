'use client';

import { useState } from 'react';

import { deleteCloudMemoryAction } from './actions';
import { DELETE_CONFIRMATION_PHRASE } from './confirm-delete';
import { emitSync } from '../../lib/sync/stak-sync';

type Status =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'working' }
  | { kind: 'error'; message: string }
  | { kind: 'done' };

export function DeleteCloudMemory({
  hasCloudMemory,
}: {
  hasCloudMemory: boolean;
}) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [value, setValue] = useState('');

  if (status.kind === 'done')
    return (
      <p role="status" className="stak-settings-p">
        Cloud Memory deleted and recovery methods revoked. Native agent Memory
        and local files on your machines are untouched.
      </p>
    );

  if (!hasCloudMemory)
    return (
      <p className="stak-settings-p">
        Nothing to delete — there&apos;s no Cloud Memory backup for this account
        yet.
      </p>
    );

  if (status.kind === 'idle')
    return (
      <button
        type="button"
        className="stak-btn stak-settings-danger"
        style={{ color: 'var(--red)' }}
        onClick={() => setStatus({ kind: 'confirming' })}
      >
        Delete Cloud Memory…
      </button>
    );

  return (
    <form
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        maxWidth: 420,
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        setStatus({ kind: 'working' });
        const result = await deleteCloudMemoryAction(value);
        if (!result.ok) {
          setStatus({
            kind: 'error',
            message: result.error ?? 'Could not delete.',
          });
          return;
        }
        emitSync(['memory', 'sidebar', 'overview']);
        setStatus({ kind: 'done' });
      }}
    >
      <label htmlFor="delete-confirm" className="stak-settings-p">
        Type{' '}
        <strong style={{ color: 'var(--ink)' }}>
          {DELETE_CONFIRMATION_PHRASE}
        </strong>{' '}
        to permanently delete every Cloud Memory backup and revoke your recovery
        methods (passkey / recovery file). Native agent Memory and local files
        on your machines are untouched.
      </label>
      <input
        id="delete-confirm"
        name="confirm"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        autoComplete="off"
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--line-2)',
          borderRadius: 6,
          padding: '8px 10px',
          color: 'var(--ink)',
          font: '13.5px var(--mono)',
        }}
      />
      {status.kind === 'error' ? (
        <p role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>
          {status.message}
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 10 }}>
        <button
          type="submit"
          className="stak-btn stak-settings-danger"
          disabled={status.kind === 'working'}
          style={{ color: 'var(--red)' }}
        >
          {status.kind === 'working' ? 'Deleting…' : 'Permanently delete'}
        </button>
        <button
          type="button"
          className="stak-btn"
          onClick={() => {
            setStatus({ kind: 'idle' });
            setValue('');
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
