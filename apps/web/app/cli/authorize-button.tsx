'use client';

import { useState } from 'react';

import { approveCli } from './actions';

type State = 'idle' | 'working' | 'done' | 'error';

export function AuthorizeButton({ userCode }: { userCode: string }) {
  const [state, setState] = useState<State>('idle');
  const [message, setMessage] = useState('');

  return (
    <div>
      <button
        className="btn"
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
      {state === 'done' && (
        <p className="muted">You can return to your terminal.</p>
      )}
      {state === 'error' && <p className="error">{message}</p>}
    </div>
  );
}
