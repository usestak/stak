'use client';

import { useState } from 'react';

import { approveCli } from './actions';

type State = 'idle' | 'working' | 'done' | 'error';

export function AuthorizeButton({ userCode }: { userCode: string }) {
  const [state, setState] = useState<State>('idle');
  const [message, setMessage] = useState('');

  if (state === 'done')
    return (
      <>
        <p className="stak-cli-success">Authorized. You&rsquo;re connected.</p>
        <p className="stak-cli-safety">You can return to your terminal.</p>
      </>
    );

  return (
    <>
      <div className="stak-cli-actions">
        <button
          className="stak-cli-approve"
          disabled={state === 'working'}
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
          {state === 'working' ? 'Approving…' : 'Approve this machine'}
        </button>
        <a className="stak-cli-decline" href="/">
          This wasn&rsquo;t me
        </a>
      </div>
      {state === 'error' ? (
        <>
          <p className="stak-cli-error">{message}</p>
          <p className="stak-cli-safety">
            Run <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>{' '}
            again in your terminal for a new code.
          </p>
        </>
      ) : (
        <p className="stak-cli-safety">
          Approving lets the CLI pull your skills and back up Memory.
          &ldquo;This wasn&rsquo;t me&rdquo; just leaves this page &mdash; it
          doesn&rsquo;t notify anyone.
        </p>
      )}
    </>
  );
}
