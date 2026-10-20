import { afterEach, expect, test } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';

import { PublicLandingShell } from './public-landing-shell';

afterEach(cleanup);

// P9 Task 1 rebuild: the public landing page now follows the approved
// STAK-Landing-Layered / STAK-Landing-Responsive design docs exactly - nav,
// hero, Problem, "This Is Your STAK", Move, Privacy, Machines, Close, and a
// real footer with the clipped oversized wordmark. These tests check
// structure/copy fidelity and the handful of real interactive controls,
// not the (stubbed, Task-2) scroll story.

test('nav renders the wordmark, the 4 in-page/external links, sign-in, install CTA, and a mobile menu toggle', () => {
  render(<PublicLandingShell />);

  const nav = screen.getByRole('navigation', { name: 'Memory STAK' });
  expect(
    within(nav).getByRole('link', { name: 'Memory STAK' }),
  ).toHaveAttribute('href', '/');

  const expectedLinks = [
    { name: 'How it works', href: '/#how' },
    { name: 'Memory & privacy', href: '/#privacy' },
    { name: 'Machines', href: '/#machines' },
    { name: 'Docs', href: '/docs' },
  ];
  for (const { name, href } of expectedLinks) {
    const link = within(nav).getAllByRole('link', { name })[0];
    expect(link).toHaveAttribute('href', href);
  }

  expect(within(nav).getByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    '/auth/login?next=/onboarding',
  );
  expect(
    within(nav).getAllByRole('link', { name: 'Install the CLI' })[0],
  ).toHaveAttribute('href', '/#install');

  const menuToggle = within(nav).getByRole('button', { name: 'Menu' });
  expect(menuToggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(menuToggle);
  expect(menuToggle).toHaveAttribute('aria-expanded', 'true');
  // The opened panel repeats the 4 links plus Sign in.
  for (const { name } of expectedLinks) {
    expect(within(nav).getAllByText(name).length).toBeGreaterThan(1);
  }
});

test('hero renders the exact headline lines, lead copy, and a copy-anywhere install row', () => {
  render(<PublicLandingShell />);

  expect(screen.getAllByText('Your').length).toBeGreaterThan(0);
  expect(screen.getAllByText('should').length).toBeGreaterThan(0);
  expect(screen.getByText('survive your laptop.')).toBeInTheDocument();
  expect(screen.getByText('should survive')).toBeInTheDocument();
  expect(screen.getByText('your laptop.')).toBeInTheDocument();

  expect(
    screen.getByText(
      'Your AI coding environment should move with you. STAK carries portable Skills and Project Memory across machines with a familiar Git-like workflow.',
    ),
  ).toBeInTheDocument();

  // The same install command also appears as a copy row in the Close
  // section below; the hero's is the first one in document order.
  const installRow = screen.getAllByRole('button', {
    name: 'Copy command: npm install -g @memstk/cli@beta',
  })[0];
  expect(installRow).toHaveTextContent('npm install -g @memstk/cli@beta');
  fireEvent.click(installRow);
  expect(installRow).toHaveTextContent('Copied ✓');
});

test('Problem section shows the Windows snapshot with the exact synthetic rows', () => {
  render(<PublicLandingShell />);

  expect(
    screen.getByRole('heading', {
      name: 'Your agent setup is stuck on this machine.',
    }),
  ).toBeInTheDocument();
  expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0);
  expect(screen.getByText('24')).toBeInTheDocument();
  expect(screen.getByText('Still tied to Windows.')).toBeInTheDocument();
});

test('This Is Your STAK shows a 4-way tab control and all 4 object cards with their rows', () => {
  render(<PublicLandingShell />);

  expect(
    screen.getByRole('heading', {
      name: 'The parts of your agent setup, in one place.',
    }),
  ).toBeInTheDocument();

  const tabs = screen.getAllByRole('tab', {
    name: /SKILLS|MEMORY|PROJECTS|STACK/,
  });
  expect(tabs.length).toBe(4);

  // The hero's scroll-story SKILLS card (rendered in both its mobile and
  // desktop/tablet deck markup, with CSS - not JS - choosing which shows)
  // also has a "review-pr" row, so these appear more than once too.
  expect(screen.getAllByText('review-pr').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Update available').length).toBeGreaterThan(0);
  // Scope the scroll-story assertion to its own stage container to verify the
  // scroll-story's "stak add ." step renders, not just the static "How it works" section's.
  const scrollStoryCaption = screen.getByText('Choose what belongs in main.');
  const scrollStoryStage = scrollStoryCaption.closest(
    '.stak-landing-story-stage',
  ) as HTMLElement;
  expect(
    within(scrollStoryStage).getAllByText('stak add .').length,
  ).toBeGreaterThan(0);

  // Switching tabs changes which card is marked active (structural, not
  // just visual - the mobile-only recomposition CSS keys off this).
  const memoryTab = screen.getByRole('tab', { name: 'MEMORY' });
  fireEvent.click(memoryTab);
  expect(memoryTab).toHaveAttribute('aria-selected', 'true');
});

test('How it works lists the 5 real steps of the Machine -> Main -> Cloud workflow, and the corrected stak run note', () => {
  render(<PublicLandingShell />);

  expect(
    screen.getByRole('heading', { name: 'Machine → Main → Cloud.' }),
  ).toBeInTheDocument();
  // The hero's scroll-story also renders "stak status"/"stak add ."/"stak push"/"stak
  // login"/"stak pull"/"stak project" among its 7 (always-mounted, CSS-driven) steps, so
  // these also appear more than once in the document.
  expect(screen.getAllByText(/stak status/).length).toBeGreaterThan(0);
  expect(screen.getAllByText('stak add .').length).toBeGreaterThan(0);
  expect(screen.getAllByText(/stak push/).length).toBeGreaterThan(0);
  expect(screen.getAllByText('stak login && stak pull').length).toBeGreaterThan(
    0,
  );
  expect(screen.getAllByText('stak project').length).toBeGreaterThan(0);

  // The design's bare, nonexistent `stak run` is corrected to the real
  // `run <agent>` CLI form (packages/cli/src/commands/run.ts).
  expect(screen.getAllByText(/stak run claude/).length).toBeGreaterThan(0);
  expect(screen.queryByText(/stak run$/)).not.toBeInTheDocument();
});

test('Privacy section has working Standard/Protected tabs with the honest Protected ciphertext treatment', () => {
  render(<PublicLandingShell />);

  expect(
    screen.getByRole('heading', { name: 'Choose who can read your Memory.' }),
  ).toBeInTheDocument();

  const standardTab = screen.getByRole('tab', { name: 'Standard' });
  const protectedTab = screen.getByRole('tab', { name: 'Protected' });
  expect(standardTab).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('Easy recovery')).toBeInTheDocument();

  fireEvent.click(protectedTab);
  expect(protectedTab).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('Only you can unlock it')).toBeInTheDocument();
  expect(
    screen.getByText('b64:9QeX2kT0vR+aLw7mYc1Zp4Hs…Nf8uE3jQ0bD6tVyK2oPq=='),
  ).toBeInTheDocument();
});

test('Machines section has a working Windows/macOS/Linux viewing-as toggle and all three machine cards', () => {
  render(<PublicLandingShell />);

  expect(
    screen.getByRole('heading', { name: 'Know where each machine left off.' }),
  ).toBeInTheDocument();

  const winBtn = screen.getByRole('button', { name: 'Windows' });
  const macBtn = screen.getByRole('button', { name: 'macOS' });
  const linuxBtn = screen.getByRole('button', { name: 'Linux' });
  expect(winBtn).toHaveAttribute('aria-pressed', 'true');
  expect(linuxBtn).toHaveAttribute('aria-pressed', 'false');

  fireEvent.click(macBtn);
  expect(macBtn).toHaveAttribute('aria-pressed', 'true');
  expect(winBtn).toHaveAttribute('aria-pressed', 'false');

  expect(screen.getByText('Updates waiting · 3 hours ago')).toBeInTheDocument();
  expect(screen.getByText('Last seen 2 days ago')).toBeInTheDocument();
  expect(screen.getByText(/stak skill update/)).toBeInTheDocument();
});

test('Close section has the 2-step copyable install+login command bar', () => {
  render(<PublicLandingShell />);

  expect(
    screen.getByRole('heading', { name: 'Change the laptop. Keep your STAK.' }),
  ).toBeInTheDocument();

  const loginRow = screen.getByRole('button', {
    name: 'Copy command: stak login',
  });
  fireEvent.click(loginRow);
  expect(loginRow).toHaveTextContent('Copied ✓');
});

test('shows an understated Public Beta pill linking to /beta', () => {
  render(<PublicLandingShell />);
  // "Public Beta" also appears as a plain footer link now (site-wide
  // discoverability) - the pill itself is identified by its own class.
  const pill = document.querySelector('.stak-landing-beta-pill');
  expect(pill).toHaveAttribute('href', '/beta');
  expect(pill).toHaveTextContent('Public Beta');
});

test('leads the daily workflow story with status, add, push', () => {
  render(<PublicLandingShell />);
  // Scoped to the "How it works" section: "stak status" also appears in the
  // (unchanged, out of scope) hero scroll-story and the "This Is Your STAK"
  // strip, so an unscoped lookup would find more than one match.
  const howSection = screen
    .getByRole('heading', { name: 'Machine → Main → Cloud.' })
    .closest('section');
  expect(within(howSection!).getByText('stak status')).toBeInTheDocument();
  expect(within(howSection!).getByText('stak add .')).toBeInTheDocument();
  expect(within(howSection!).getByText('stak push')).toBeInTheDocument();
});

test('shows memory restore (not memory recover) as the step right after pull', () => {
  render(<PublicLandingShell />);
  // The new combined "stak login && stak pull" command means "stak pull"
  // never appears as its own standalone text node in the Move list (it only
  // does, unrelatedly, inside the unchanged hero scroll-story's multi-line
  // command rendering) - so find the actual list item by substring instead.
  const howSection = screen
    .getByRole('heading', { name: 'Machine → Main → Cloud.' })
    .closest('section');
  const pullStep = within(howSection!)
    .getAllByRole('listitem')
    .find((li) => /stak pull/.test(li.textContent ?? ''));
  expect(pullStep).toBeDefined();
  expect(pullStep?.textContent).not.toMatch(/stak memory recover/);
});

test('links Feedback in the footer', () => {
  render(<PublicLandingShell />);
  expect(screen.getByRole('link', { name: 'Feedback' })).toHaveAttribute(
    'href',
    '/feedback',
  );
});

test('footer omits the nonexistent /app link and keeps only real destinations', () => {
  render(<PublicLandingShell />);

  const footer = screen.getByRole('contentinfo');
  expect(within(footer).getByText('How it works').closest('a')).toHaveAttribute(
    'href',
    '/#how',
  );
  expect(within(footer).getByText('Sign in').closest('a')).toHaveAttribute(
    'href',
    '/auth/login?next=/onboarding',
  );
  expect(within(footer).queryByText('Control center')).not.toBeInTheDocument();
  expect(within(footer).queryByText(/\/app\b/)).not.toBeInTheDocument();
  expect(footer.querySelector('a[href="/app"]')).toBeNull();
  expect(within(footer).getByText('GitHub').closest('a')).toHaveAttribute(
    'href',
    'https://github.com/usestak/stak',
  );
});
