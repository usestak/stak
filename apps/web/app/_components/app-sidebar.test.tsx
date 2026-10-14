import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AppSidebar } from './app-sidebar';
import { PLACEHOLDER_COUNTS } from './shell-notice';

// AppSidebar renders MachineSelector, a client component that calls
// next/navigation's useRouter/usePathname. Those hooks require an App Router
// context that only exists inside a real Next.js render tree, so we stub the
// module rather than pull in a full router mount for this unit test.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/overview',
}));

afterEach(cleanup);

const baseProps = {
  active: 'overview' as const,
  handle: 'dev@example.com',
  counts: PLACEHOLDER_COUNTS,
  viewing: {
    machineId: 'm1',
    name: 'DELL',
    statusLabel: 'Checked in 2h ago',
    dot: 'ready',
  },
  machines: [
    {
      machineId: 'm1',
      name: 'DELL',
      secondary: 'macOS · arm64',
      statusLabel: 'Checked in 2h ago',
    },
  ],
};

test('exposes a keyboard-reachable navigation toggle below desktop width', async () => {
  const user = userEvent.setup();
  render(<AppSidebar {...baseProps} />);
  const toggle = screen.getByRole('button', { name: /open navigation/i });
  expect(toggle).toBeInTheDocument();
  await user.tab();
  expect(toggle).toHaveFocus();
});

test('marks the active route with aria-current', () => {
  render(<AppSidebar {...baseProps} />);
  const link = screen.getByRole('link', { name: /overview/i });
  expect(link).toHaveAttribute('aria-current', 'page');
});

test('toggle expands the nav panel and exposes aria-expanded/aria-controls', async () => {
  const user = userEvent.setup();
  render(<AppSidebar {...baseProps} />);
  const toggle = screen.getByRole('button', { name: /open navigation/i });
  const panelId = toggle.getAttribute('aria-controls');
  expect(panelId).toBeTruthy();
  expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await user.click(toggle);

  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(toggle).toHaveAccessibleName(/close navigation/i);
  expect(document.getElementById(panelId!)).not.toBeNull();
});

test('Escape closes the open nav panel and returns focus to the toggle', async () => {
  const user = userEvent.setup();
  render(<AppSidebar {...baseProps} />);
  const toggle = screen.getByRole('button', { name: /open navigation/i });

  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');

  await user.keyboard('{Escape}');

  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(toggle).toHaveFocus();
});

test('activating a nav link closes the open panel', async () => {
  const user = userEvent.setup();
  render(<AppSidebar {...baseProps} />);
  const toggle = screen.getByRole('button', { name: /open navigation/i });
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // jsdom has no real router: suppress the anchor's default navigation so the
  // test only observes AppSidebar's own close-on-click behavior.
  const preventNav = (e: MouseEvent) => e.preventDefault();
  document.addEventListener('click', preventNav);
  const settingsLink = screen.getByRole('link', { name: /settings/i });
  try {
    await user.click(settingsLink);
  } finally {
    document.removeEventListener('click', preventNav);
  }

  expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('renders all primary routes and account identity', () => {
  render(<AppSidebar {...baseProps} />);
  for (const name of [
    /overview/i,
    /skills/i,
    /memory/i,
    /projects/i,
    /machines/i,
    /staks/i,
    /settings/i,
  ]) {
    expect(screen.getByRole('link', { name })).toBeInTheDocument();
  }
  expect(screen.getByText(baseProps.handle)).toBeInTheDocument();
});
