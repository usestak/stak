import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PublicLandingShell } from './_components/public-landing-shell';
import { siteOrigin } from '@/lib/site-origin';
import { getSessionUser } from '@/lib/session';

const description =
  'Memory STAK is the control plane for portable AI agent environments: back up the Memory your coding agents rely on, carry Skills between machines, and bring your whole setup with you — any agent, any machine.';

export const metadata: Metadata = {
  // Next.js only threads a layout's title template down to a page when at
  // least one intermediate layout separates them (see
  // resolve-metadata.js: `accumulateMetadata` skips the template-update step
  // for "the leaf layout and leaf page", which is exactly `app/layout.tsx` +
  // `app/page.tsx` here). The root layout's `template: 'Memory STAK — %s'`
  // never reaches this page, so the brand prefix is spelled out explicitly to
  // match what actually renders in `<title>` and in Open Graph below.
  title: 'Memory STAK — Portable AI agent environments',
  description,
  alternates: { canonical: siteOrigin() },
  openGraph: {
    title: 'Memory STAK — Portable AI agent environments',
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
  // the full public landing composition below (P9 Task 2: the real S.01
  // design-contract structure - nav, split hero, feature strip, and truthful
  // product-explainer sections - replacing the narrow FocusedShell card from
  // commit c9f7c05, which didn't match the approved design).
  if (await getSessionUser()) redirect('/onboarding');

  return <PublicLandingShell />;
}
