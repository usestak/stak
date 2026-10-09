import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { FocusedShell } from './_components/focused-shell';
import { siteOrigin } from '@/lib/site-origin';
import { getSessionUser } from '@/lib/session';

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
  // the full landing content below, rendered through the same approved
  // FocusedShell composition as auth/onboarding/device-authorization, kept
  // real SEO content (one <h1>, server-rendered prose) via FocusedShell's
  // `title` prop rather than a hand-built public-page layout.
  if (await getSessionUser()) redirect('/onboarding');

  return (
    <FocusedShell title="STAK is the control plane for portable AI agent environments.">
      <p>Your skills. Your memory. Your setup. Any agent. Any machine.</p>

      <div className="stak-focus-actions">
        <a className="stak-btn" href="/auth/login?next=/onboarding">
          Sign in with GitHub
        </a>
      </div>

      <p>
        Coding agents like Claude Code and Codex build up Skills and Memory as
        you work with them — context that&apos;s easy to lose when you switch
        machines. STAK keeps that Memory backed up and your Skills reproducible,
        so the agent on a new machine picks up where the last one left off
        instead of starting cold.
      </p>

      <p>
        Your STAK should survive your laptop. Memory you&apos;ve backed up can
        be recovered with a passkey, Skills can be checked out again, and
        projects can be mapped back onto a new machine instead of rebuilding
        from scratch.
      </p>

      <p className="stak-focus-eyebrow">From your terminal</p>
      <pre className="stak-cmd">
        <code>{`stak login\nstak scan\nstak memory backup`}</code>
      </pre>

      <p>
        Authorizing a device? Continue to{' '}
        <a href="/cli">device authorization</a>.
      </p>
    </FocusedShell>
  );
}
