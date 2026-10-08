'use client';

import { useState } from 'react';

import { approveCli } from './actions';

type State = 'idle' | 'working' | 'done' | 'error';

export function AuthorizeButton({ userCode }: { userCode: string }) {
  const [state, setState] = useState<State>('idle');
  const [message, setMessage] = useState('');

  return (
    <div
      className="stak-focus-actions"
      style={{ flexDirection: 'column', alignItems: 'flex-start' }}
    >
      <button
        className="stak-btn"
        disabled={state === 'working' || state === 'done'}
        onClick={async () => {
          setState('working');
          const result = await approveCli(userCode);
          if (result.ok) {
            setState('done');
          } else {
            setState('error');
            setMessage(result.error ?? 'Approval failed.');
          }
        }}
      >
        {state === 'done'
          ? 'Authorized ✓'
          : state === 'working'
            ? 'Authorizing…'
            : 'Authorize this device'}
      </button>
      {state === 'done' && <p>You can return to your terminal.</p>}
      {state === 'error' && (
        <>
          <p className="stak-focus-error">{message}</p>
          <p>
            Run <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>{' '}
            again in your terminal for a new code.
          </p>
        </>
      )}
    </div>
  );
}
