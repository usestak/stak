'use client';

import { useState } from 'react';

import {
  bridgeFailure,
  credentialIdFromB64url,
  detectCapabilities,
  getPrfOutput,
  sealMmkForCli,
  unwrapMmkWithPrf,
  type BridgeFailureReason,
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

  // Tell the waiting CLI the ceremony ended so it stops polling immediately and shows
  // the recovery-file fallback, instead of waiting out the session timeout. Best-effort
  // (never throws) and consumes the one-time session, so it is never read as success.
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
              : `This recovery request is ${fetched.reason}. Start again from the CLI.`,
        });
        return;
      }
      const bridgeSession = fetched.session as BridgeSessionPublic;

      setStatus({ kind: 'working', message: 'Authenticating your passkey…' });
      const wrappersResp = await listPasskeyWrappersAction();
      if (!wrappersResp.ok || wrappersResp.wrappers.length === 0) {
        await signalFailure('unsupported');
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
          await signalFailure('unsupported');
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
        await signalFailure('error');
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
      const cancelled =
        error instanceof Error && error.name === 'NotAllowedError';
      await signalFailure(cancelled ? 'cancelled' : 'provider-error');
      setStatus({
        kind: 'error',
        message: cancelled
          ? 'Passkey prompt was cancelled. You can try again, or use your recovery file.'
          : 'Couldn’t complete the passkey request. Try again, or use your recovery file.',
      });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {status.kind === 'done' ? (
        <p className="stak-focus-success">
          Memory unlocked. Return to your terminal to finish.
        </p>
      ) : (
        <button
          className="stak-btn"
          onClick={() => void run()}
          disabled={status.kind === 'working'}
        >
          {status.kind === 'working' ? 'Working…' : 'Continue with passkey'}
        </button>
      )}
      {status.kind === 'working' && <p>{status.message}</p>}
      {status.kind === 'unsupported' && <p>{status.message}</p>}
      {status.kind === 'error' && (
        <p className="stak-focus-error">{status.message}</p>
      )}
    </div>
  );
}
