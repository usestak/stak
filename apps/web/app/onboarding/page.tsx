import { redirect } from 'next/navigation';

import { FocusedShell } from '@/app/_components/focused-shell';
import { getCloudService } from '@/lib/cloud-service';
import { displayNameOf, getSessionUser } from '@/lib/session';

import { loadOnboardingView, type OnboardingStep } from './onboarding-data';

export const dynamic = 'force-dynamic';

const StepRow = ({ step, index }: { step: OnboardingStep; index: number }) => (
  <div
    style={{
      display: 'flex',
      gap: 14,
      padding: '14px 0',
      borderBottom: '1px solid var(--line)',
      alignItems: 'flex-start',
    }}
  >
    <span
      style={{
        width: 20,
        height: 20,
        borderRadius: '50%',
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        font: '600 11px var(--mono)',
        background: step.done ? 'var(--green)' : 'transparent',
        border: step.done ? 'none' : '1.5px solid var(--chip)',
        color: step.done ? 'var(--panel)' : 'var(--dim)',
      }}
      aria-hidden
    >
      {step.done ? '✓' : index + 1}
    </span>
    <div>
      <div
        style={{
          fontSize: 14.5,
          color: step.done ? 'var(--faint)' : 'var(--ink)',
        }}
      >
        {step.label}
        {step.optional ? (
          <span style={{ color: 'var(--dim)' }}> · optional</span>
        ) : null}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--dim)', marginTop: 3 }}>
        {step.detail}
      </div>
    </div>
  </div>
);

export default async function OnboardingPage() {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadOnboardingView(getCloudService(), user);

  if (view.kind === 'error')
    return (
      <FocusedShell title="Couldn't load your setup">
        <p>
          STAK Cloud didn&apos;t respond. This is a temporary problem, not a
          change to your account. Reload to try again.
        </p>
      </FocusedShell>
    );

  if (view.kind === 'skip') redirect('/overview');

  const isNewAccount = view.mode === 'new-account';

  return (
    <FocusedShell
      title={
        isNewAccount
          ? `Welcome to STAK, ${handle}.`
          : 'Bring your STAK to this machine.'
      }
    >
      <p>
        Setup runs in your terminal. This page follows along as the CLI reports
        each step — it can&apos;t run commands for you.
      </p>

      {isNewAccount ? (
        <div>
          {view.steps.map((step, index) => (
            <StepRow key={step.key} step={step} index={index} />
          ))}
        </div>
      ) : (
        <div>
          <p>Your STAK already has Cloud Memory. On the new machine, run:</p>
          <pre className="stak-cmd">
            <code>{`stak login\nstak memory recover\nstak memory restore`}</code>
          </pre>
          <p>
            <code style={{ fontFamily: 'var(--mono)' }}>recover</code> brings
            your Memory down from Cloud to this machine.{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>restore</code> writes it
            into your agents&apos; files — it never overwrites anything already
            there. If your Memory is Protected, recover needs a passkey or your
            recovery file from this account.
          </p>
          <p>
            Map projects if needed — any project not already present on this
            machine:{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>
              stak project map &lt;project&gt; &lt;directory&gt;
            </code>
          </p>
        </div>
      )}

      <div className="stak-focus-actions">
        <a className="stak-btn" href="/overview">
          Go to Overview
        </a>
      </div>
    </FocusedShell>
  );
}
