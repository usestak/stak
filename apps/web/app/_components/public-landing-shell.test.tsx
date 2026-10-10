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
