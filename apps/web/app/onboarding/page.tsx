import { redirect } from 'next/navigation';

import { SiteHeader } from '@/app/_components/site-header';
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
      borderBottom: '1px solid #232220',
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
        background: step.done ? '#84cb8e' : 'transparent',
        border: step.done ? 'none' : '1.5px solid #3a3934',
        color: step.done ? '#121211' : '#85817a',
      }}
      aria-hidden
    >
      {step.done ? '✓' : index + 1}
    </span>
    <div>
      <div style={{ fontSize: 14.5, color: step.done ? '#a19d94' : '#edeae3' }}>
        {step.label}
        {step.optional ? (
          <span style={{ color: '#85817a' }}> · optional</span>
        ) : null}
      </div>
      <div style={{ fontSize: 12.5, color: '#85817a', marginTop: 3 }}>
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
      <>
        <SiteHeader user={user} />
        <div className="page">
          <main>
            <h1>Couldn&apos;t load your setup</h1>
            <p className="lead">
              STAK Cloud didn&apos;t respond. This is a temporary problem, not a
              change to your account. Reload to try again.
            </p>
          </main>
        </div>
      </>
    );

  if (view.kind === 'skip') redirect('/overview');

  const isNewAccount = view.mode === 'new-account';

  return (
    <>
      <SiteHeader user={user} />
      <div className="page">
        <main>
          <h1>
            {isNewAccount
              ? `Welcome to STAK, ${handle}.`
              : 'Bring your STAK to this machine.'}
          </h1>
          <p className="lead">
            Setup runs in your terminal. This page follows along as the CLI
            reports each step — it can&apos;t run commands for you.
          </p>

          {isNewAccount ? (
            <div style={{ marginTop: '1.5rem', maxWidth: 640 }}>
              {view.steps.map((step, index) => (
                <StepRow key={step.key} step={step} index={index} />
              ))}
            </div>
          ) : (
            <div style={{ marginTop: '1.5rem', maxWidth: 640 }}>
              <p>
                Your STAK already has Cloud Memory. On the new machine, run:
              </p>
              <pre>
                <code>{`stak login\nstak memory recover\nstak memory restore`}</code>
              </pre>
              <p className="muted">
                <code style={{ fontFamily: 'var(--mono)' }}>recover</code>{' '}
                brings your Memory down from Cloud to this machine.{' '}
                <code style={{ fontFamily: 'var(--mono)' }}>restore</code>{' '}
                writes it into your agents&apos; files — it never overwrites
                anything already there. If your Memory is Protected, recover
                needs a passkey or your recovery file (.stackkey) from this
                account.
              </p>
              <p className="muted">
                Map projects if needed — any project not already present on this
                machine:{' '}
                <code style={{ fontFamily: 'var(--mono)' }}>
                  stak project map &lt;project&gt; &lt;directory&gt;
                </code>
              </p>
            </div>
          )}

          <p style={{ marginTop: '1.5rem' }}>
            <a className="btn" href="/overview">
              Go to Overview
            </a>
          </p>
        </main>
      </div>
    </>
  );
}
