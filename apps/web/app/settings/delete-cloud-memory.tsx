'use client';

import { useState } from 'react';

import { deleteCloudMemoryAction } from './actions';
import { DELETE_CONFIRMATION_PHRASE } from './confirm-delete';

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
      <p role="status" style={{ fontSize: 13.5, color: '#a19d94' }}>
        Cloud Memory deleted and recovery methods revoked. Local Memory on your
        machines is untouched.
      </p>
    );

  if (!hasCloudMemory)
    return (
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Nothing to delete — STAK has no Cloud Memory backup for this account
        yet.
      </p>
    );

  if (status.kind === 'idle')
    return (
      <button
        type="button"
        className="btn btn-secondary"
        style={{
          alignSelf: 'flex-start',
          border: '1px solid #5a2a24',
          color: '#e5776a',
        }}
        onClick={() => setStatus({ kind: 'confirming' })}
      >
        Delete cloud Memory…
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
        setStatus({ kind: 'done' });
      }}
    >
      <label
        htmlFor="delete-confirm"
        style={{ fontSize: 13, color: '#a19d94' }}
      >
        Type{' '}
        <strong style={{ color: '#edeae3' }}>
          {DELETE_CONFIRMATION_PHRASE}
        </strong>{' '}
        to permanently delete every Cloud Memory backup STAK holds and revoke
        your recovery methods (passkey / recovery file). Native agent Memory and
        all files on your machines are not touched.
      </label>
      <input
        id="delete-confirm"
        name="confirm"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        autoComplete="off"
        style={{
          background: '#1a1917',
          border: '1px solid #2a2926',
          borderRadius: 6,
          padding: '8px 10px',
          color: '#edeae3',
          font: '13.5px var(--mono)',
        }}
      />
      {status.kind === 'error' ? (
        <p role="alert" style={{ fontSize: 13, color: '#e5776a' }}>
          {status.message}
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 10 }}>
        <button
          type="submit"
          className="btn"
          disabled={status.kind === 'working'}
          style={{ border: '1px solid #5a2a24', color: '#e5776a' }}
        >
          {status.kind === 'working' ? 'Deleting…' : 'Permanently delete'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
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
