import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { siteOrigin } from '@/lib/site-origin';
import { getSessionUser } from '@/lib/session';

import '../app/overview/shell.css';
import './_components/public-shell.css';
import './_components/focused-shell.css';

const description =
  'STAK is the control plane for portable AI agent environments: back up the Memory your coding agents rely on, carry Skills between machines, and bring your whole setup with you — any agent, any machine.';

export const metadata: Metadata = {
  // Next.js only threads a layout's title template down to a page when at
  // least one intermediate layout separates them (see
  // resolve-metadata.js: `accumulateMetadata` skips the template-update step
  // for "the leaf layout and leaf page", which is exactly `app/layout.tsx` +
  // `app/page.tsx` here). The root layout's `template: 'STAK — %s'` never
  // reaches this page, so the brand prefix is spelled out explicitly to
  // match what actually renders in `<title>` and in Open Graph below.
  title: 'STAK — Portable AI agent environments',
  description,
  alternates: { canonical: siteOrigin() },
  openGraph: {
    title: 'STAK — Portable AI agent environments',
    description,
    url: siteOrigin(),
  },
  robots: { index: true, follow: true },
};

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // Signed-in users go through onboarding's own real-state check, which sends
  // an already-established account straight on to Overview (never trapped).
  // This redirect never fires for an anonymous visitor or crawler — they see
  // the full landing content below.
  if (await getSessionUser()) redirect('/onboarding');

  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        rel="preconnect"
        href="https://fonts.gstatic.com"
        crossOrigin="anonymous"
      />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
      />
      <div className="stak stak-public">
        <nav className="stak-public-nav" aria-label="STAK">
          <span className="stak-public-wordmark">STAK</span>
        </nav>
        <main id="main-content" className="stak-public-main">
          <h1>STAK is the control plane for portable AI agent environments.</h1>
          <p className="stak-public-muted">
            Your skills. Your memory. Your setup. Any agent. Any machine.
          </p>

          <div className="stak-focus-actions">
            <a className="stak-btn" href="/auth/login?next=/onboarding">
              Sign in with GitHub
            </a>
          </div>

          <h2>Move your setup, not just your code</h2>
          <p>
            Coding agents like Claude Code and Codex build up Skills and Memory
            as you work with them — context that&apos;s easy to lose when you
            switch machines. STAK keeps that Memory backed up and your Skills
            reproducible, so the agent on a new machine picks up where the last
            one left off instead of starting cold.
          </p>

          <h2>Your STAK should survive your laptop.</h2>
          <p>
            Laptops get replaced, wiped, or lost — that shouldn&apos;t mean
            losing everything an agent has learned about your projects. Your
            STAK should survive your laptop: Memory you&apos;ve backed up can be
            recovered with a passkey, Skills can be checked out again, and
            projects can be mapped back onto a new machine instead of rebuilding
            from scratch.
          </p>

          <h2>From your terminal</h2>
          <p>
            STAK is driven from the CLI, not a dashboard you manage by hand. The
            web app shows what&apos;s already true about your machines.
          </p>
          <p className="stak-focus-eyebrow">On a machine with your STAK</p>
          <pre className="stak-cmd">
            <code>{`stak login\nstak scan\nstak memory backup`}</code>
          </pre>

          <p>
            Authorizing a device? Continue to{' '}
            <a href="/cli">device authorization</a>.
          </p>
        </main>
      </div>
    </>
  );
}
