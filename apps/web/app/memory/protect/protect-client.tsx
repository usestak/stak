'use client';

import { useState } from 'react';

import {
  bridgeFailure,
  createPasskeyCredential,
  credentialIdToB64url,
  detectCapabilities,
  getPrfOutput,
  randomMmk,
  sealMmkForCli,
  wrapMmkWithPrf,
  type BridgeFailureReason,
  type BridgeSessionPublic,
} from '@/lib/recovery-webcrypto';

import {
  addPasskeyMethodAction,
  fetchSessionAction,
  submitEnvelopeAction,
} from '../actions';

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; message: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'done' };

export function ProtectClient({
  sessionId,
  rpId,
  userName,
}: {
  sessionId: string;
  rpId: string;
  userName: string;
}) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // Tell the waiting CLI the ceremony ended so it stops polling immediately instead of
  // waiting out the session timeout. Best-effort; consumes the one-time session so a
  // failed setup is never read as success.
  const signalFailure = async (reason: BridgeFailureReason) => {
    try {
      await submitEnvelopeAction(sessionId, bridgeFailure(reason));
    } catch {
      // ignore: the CLI still ends via its bounded timeout.
    }
  };

  const run = async () => {
    setStatus({ kind: 'working', message: 'Checking passkey support…' });
    try {
      const caps = await detectCapabilities();
      if (!caps.passkeySupported) {
        await signalFailure('unsupported');
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
              : `This setup request is ${fetched.reason}. Start again from the CLI.`,
        });
        return;
      }
      const bridgeSession = fetched.session as BridgeSessionPublic;

      setStatus({ kind: 'working', message: 'Creating your passkey…' });
      const { credentialId } = await createPasskeyCredential({
        rpId,
        rpName: 'STAK Memory',
        userName,
      });

      const prf = await getPrfOutput({ rpId, credentialId }).catch(() => null);
      if (!prf) {
        await signalFailure('unsupported');
        setStatus({
          kind: 'unsupported',
          message:
            'Your passkey works, but this browser or authenticator does not provide the ' +
            'encryption capability STAK Memory requires. Use a recovery file instead.',
        });
        return;
      }

      setStatus({ kind: 'working', message: 'Securing your Memory key…' });
      const mmk = randomMmk();
      const stored = await wrapMmkWithPrf({
        mmk,
        prfOutput: prf,
        label: 'Passkey',
      });
      prf.fill(0);
      const added = await addPasskeyMethodAction({
        label: 'Passkey',
        publicIdentifier: credentialIdToB64url(credentialId),
        mmkWrapper: stored,
      });
      if (!added.ok) {
        setStatus({
          kind: 'error',
          message: added.error ?? 'Could not save your passkey.',
        });
        return;
      }

      setStatus({
        kind: 'working',
        message: 'Finishing setup in your terminal…',
      });
      const envelope = await sealMmkForCli({ session: bridgeSession, mmk });
      mmk.fill(0);
      const submitted = await submitEnvelopeAction(sessionId, envelope);
      if (!submitted.ok) {
        setStatus({
          kind: 'error',
          message: submitted.error ?? 'Could not complete setup.',
        });
        return;
      }
      setStatus({ kind: 'done' });
    } catch (error) {
      const cancelled =
        error instanceof Error && error.name === 'NotAllowedError';
      await signalFailure(cancelled ? 'cancelled' : 'provider-error');
      setStatus({
        kind: 'error',
        message: cancelled
          ? 'Passkey setup cancelled. You can try again when you’re ready.'
          : 'Couldn’t complete passkey setup. You can try again.',
      });
    }
  };

  return (
    <div style={{ marginTop: '1.5rem' }}>
      {status.kind === 'done' ? (
        <p className="ok">
          Protected backup enabled. Return to your terminal to finish.
        </p>
      ) : (
        <button
          className="btn"
          onClick={() => void run()}
          disabled={status.kind === 'working'}
        >
          {status.kind === 'working' ? 'Working…' : 'Set up passkey'}
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
