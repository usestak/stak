import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import { PublicLandingShell } from './public-landing-shell';

afterEach(cleanup);

// P9 quality fix: below 1024px the 4 in-page nav links (How it works /
// Memory & privacy / Stacks / CLI) move behind a native <details> disclosure
// instead of being dropped from the DOM, so they stay reachable at every
// width. This asserts the disclosure exists, carries the same links/hrefs as
// the always-visible desktop nav, and is keyboard-operable (native
// <details>/<summary> needs no extra wiring for that).
test('mobile/tablet nav disclosure exposes the 4 in-page nav links with correct hrefs', () => {
  render(<PublicLandingShell />);

  const expectedLinks = [
    { name: 'How it works', href: '#how-it-works' },
    { name: 'Memory & privacy', href: '#memory-privacy' },
    { name: 'Stacks', href: '#stacks' },
    { name: 'CLI', href: '#install' },
  ];

  // The desktop nav-links row still renders the same 4 links (hidden by CSS
  // below 1024px, not removed from markup).
  const nav = screen.getByRole('navigation', { name: 'STAK' });
  for (const { name, href } of expectedLinks) {
    const link = within(nav).getAllByRole('link', { name })[0];
    expect(link).toHaveAttribute('href', href);
  }

  // The disclosure toggle has a clear accessible name and starts closed.
  const toggle = screen.getByText('Menu');
  expect(toggle.tagName).toBe('SUMMARY');
  expect(toggle).toHaveAttribute('aria-label', 'Navigation');
  const details = toggle.closest('details');
  expect(details).not.toBeNull();
  expect(details).not.toHaveAttribute('open');

  // The panel inside the disclosure carries the same 4 links/hrefs.
  for (const { name, href } of expectedLinks) {
    const links = within(details!).getAllByRole('link', { name });
    expect(links.length).toBeGreaterThan(0);
    expect(links[links.length - 1]).toHaveAttribute('href', href);
  }

  // Sign in / Install the CLI stay outside the disclosure and remain
  // directly reachable, unchanged by this fix.
  expect(within(nav).getByText('Sign in')).toBeInTheDocument();
  expect(within(nav).getByText('Install the CLI')).toBeInTheDocument();
  expect(details!.contains(within(nav).getByText('Sign in'))).toBe(false);
});

// P9 Task 4 (landing storytelling): each major section gets one concrete
// product-derived proof visual. These assertions check the visual exists,
// carries honest synthetic content, and never regresses the two hard
// constraints called out in the brief: Task S3's Protected-Memory fix
// (no fabricated per-project file count next to Protected) and the frozen
// status vocabulary (no banned live-connectivity words).
test('Skills section pairs its claim with a before/after diff proof visual', () => {
  render(<PublicLandingShell />);
  expect(
    screen.getByRole('heading', { name: 'Skills' }),
  ).toBeInTheDocument();
  expect(
    screen.getAllByText('code-review-checklist').length,
  ).toBeGreaterThan(0);
  expect(screen.getByText('Update available')).toBeInTheDocument();
  expect(screen.getByText(/Flag missing error handling/)).toBeInTheDocument();
});

test('Memory & privacy section shows an honest Standard-vs-Protected proof with no fabricated Protected file count', () => {
  render(<PublicLandingShell />);
  expect(screen.getByText('3 projects · 41 files')).toBeInTheDocument();
  // Exact honest phrasing from Task S3's fix - never a per-project file
  // count next to Protected.
  const protectedCount = screen.getAllByText('9 projects known to STAK');
  expect(protectedCount.length).toBeGreaterThan(0);
  expect(screen.queryByText(/files across 9 projects/)).not.toBeInTheDocument();
});

test('Machines section shows a desired-vs-reported card with frozen vocabulary only, no live-connectivity claim', () => {
  render(<PublicLandingShell />);
  expect(
    screen.getByRole('heading', { name: 'Machines' }),
  ).toBeInTheDocument();
  expect(screen.getByText('Needs attention')).toBeInTheDocument();
  expect(screen.getByText(/not a live\s*connection/)).toBeInTheDocument();
  expect(screen.queryByText(/\bOnline\b/)).not.toBeInTheDocument();
  expect(screen.queryByText(/\bIn sync\b/)).not.toBeInTheDocument();
});

test('Stacks section shows a composition crop with only the main Stack and Included/Paused rows', () => {
  render(<PublicLandingShell />);
  expect(
    screen.getByRole('heading', { name: 'Stacks' }),
  ).toBeInTheDocument();
  expect(screen.getByText('Your main Stack')).toBeInTheDocument();
  expect(screen.getAllByText('Included').length).toBe(2);
  expect(screen.getByText('Paused')).toBeInTheDocument();
});

test('Move to a new machine shows the DELL -> STAK -> MacBook flow above the real 7-step sequence', () => {
  render(<PublicLandingShell />);
  const section = screen
    .getByRole('heading', { name: 'Move to a new machine' })
    .closest('section')!;
  expect(within(section).getByText('DELL')).toBeInTheDocument();
  expect(within(section).getByText('STAK')).toBeInTheDocument();
  expect(within(section).getByText('MacBook')).toBeInTheDocument();
  expect(within(section).getByText('New machine')).toBeInTheDocument();
});
