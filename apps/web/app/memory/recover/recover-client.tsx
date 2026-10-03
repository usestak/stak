'use client';

import { useState } from 'react';

import {
  credentialIdFromB64url,
  detectCapabilities,
  getPrfOutput,
  sealMmkForCli,
  unwrapMmkWithPrf,
  type BridgeSessionPublic,
  type StoredMmkWrapper,
} from '@/lib/recovery-webcrypto';

import {
  fetchSessionAction,
  listPasskeyWrappersAction,
  submitEnvelopeAction,
} from '../actions';

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; message: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'done' };

export function RecoverClient({
  sessionId,
  rpId,
}: {
  sessionId: string;
  rpId: string;
}) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const run = async () => {
    setStatus({ kind: 'working', message: 'Checking passkey support…' });
    try {
      const caps = await detectCapabilities();
      if (!caps.passkeySupported) {
        setStatus({
          kind: 'unsupported',
          message:
            'This browser does not support passkeys. Use a recovery file instead.',
        });
        return;
      }

      const fetched = await fetchSessionAction(sessionId);
      if (!fetched.ok) {
        setStatus({
          kind: 'error',
          message:
            fetched.reason === 'not-signed-in'
              ? 'Please sign in and try again.'
              : `This recovery request is ${fetched.reason}. Start again from the CLI.`,
        });
        return;
      }
      const bridgeSession = fetched.session as BridgeSessionPublic;

      setStatus({ kind: 'working', message: 'Authenticating your passkey…' });
      const wrappersResp = await listPasskeyWrappersAction();
      if (!wrappersResp.ok || wrappersResp.wrappers.length === 0) {
        setStatus({
          kind: 'unsupported',
          message:
            'No passkey is set up for this account. Use a recovery file instead.',
        });
        return;
      }

      // Try each enrolled passkey wrapper until one unlocks.
      let mmk: Uint8Array | null = null;
      for (const wrapper of wrappersResp.wrappers) {
        if (!wrapper.publicIdentifier) continue;
        const prf = await getPrfOutput({
          rpId,
          credentialId: credentialIdFromB64url(wrapper.publicIdentifier),
        }).catch(() => null);
        if (!prf) {
          setStatus({
            kind: 'unsupported',
            message:
              'Your passkey works, but this browser or authenticator does not provide the ' +
              'encryption capability STAK Memory requires. Use a recovery file instead.',
          });
          return;
        }
        try {
          mmk = await unwrapMmkWithPrf({
            stored: wrapper.mmkWrapper as StoredMmkWrapper,
            prfOutput: prf,
          });
          break;
        } catch {
          // wrong passkey for this wrapper — try the next
        }
      }
      if (!mmk) {
        setStatus({
          kind: 'error',
          message: 'That passkey could not unlock your Memory.',
        });
        return;
      }

      setStatus({
        kind: 'working',
        message: 'Sending securely to your terminal…',
      });
      const envelope = await sealMmkForCli({ session: bridgeSession, mmk });
      mmk.fill(0);
      const submitted = await submitEnvelopeAction(sessionId, envelope);
      if (!submitted.ok) {
        setStatus({
          kind: 'error',
          message: submitted.error ?? 'Could not complete recovery.',
        });
        return;
      }
      setStatus({ kind: 'done' });
    } catch (error) {
      setStatus({
        kind: 'error',
        message:
          error instanceof Error && error.name === 'NotAllowedError'
            ? 'Passkey prompt was cancelled.'
            : 'Something went wrong. You can try again.',
      });
    }
  };

  return (
    <div style={{ marginTop: '1.5rem' }}>
      {status.kind === 'done' ? (
        <p className="ok">
          Memory unlocked. Return to your terminal to finish.
        </p>
      ) : (
        <button
          className="btn"
          onClick={() => void run()}
          disabled={status.kind === 'working'}
        >
          {status.kind === 'working' ? 'Working…' : 'Continue with passkey'}
        </button>
      )}
      {status.kind === 'working' && <p className="muted">{status.message}</p>}
      {status.kind === 'unsupported' && (
        <p className="muted">{status.message}</p>
      )}
      {status.kind === 'error' && <p className="error">{status.message}</p>}
    </div>
  );
}
