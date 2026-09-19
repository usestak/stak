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
        style={{
          padding: '0.6rem 1rem',
          fontSize: '1rem',
          cursor: state === 'done' ? 'default' : 'pointer',
        }}
      >
        {state === 'done' ? 'Authorized ✓' : 'Authorize this device'}
      </button>
      {state === 'done' && <p>You can return to your terminal.</p>}
      {state === 'error' && <p style={{ color: 'crimson' }}>{message}</p>}
    </div>
  );
}
