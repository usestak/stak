import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const shareSkillAction = vi.fn();
const unshareSkillAction = vi.fn();
vi.mock('../actions', () => ({
  shareSkillAction: (...args: unknown[]) => shareSkillAction(...args),
  unshareSkillAction: (...args: unknown[]) => unshareSkillAction(...args),
}));

import { SkillShareSection } from './skill-share-section';

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

const SHARED_URL = 'https://www.memstk.com/stephentony100/design-helper';

test('shareable renders a safe Share action using the suggested slug', () => {
  render(
    <SkillShareSection
      skillId="skill-1"
      share={{ status: 'shareable', suggestedSlug: 'design-helper' }}
    />,
  );

  expect(screen.getByLabelText(/public slug/i)).toHaveValue('design-helper');
  expect(screen.getByRole('button', { name: /^share$/i })).toBeInTheDocument();
});

/** Regression for the same class of bug the Vercel release-blocking type error exposed on
 *  the named-Stack side: `upload-required` intentionally carries no owner/slug/url, so the
 *  UI must never assume them. */
test('upload-required renders without accessing slug/url metadata, tells the user to push, and offers no Share action', () => {
  render(
    <SkillShareSection
      skillId="skill-1"
      share={{ status: 'upload-required' }}
    />,
  );

  expect(screen.getByText(/upload required/i)).toBeInTheDocument();
  expect(screen.getByText('stak push').tagName).toBe('CODE');
  expect(
    screen.queryByRole('button', { name: /^share$/i }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/public slug/i)).not.toBeInTheDocument();
});

test('not-shareable shows the eligibility reason, never a Share action', () => {
  render(
    <SkillShareSection
      skillId="skill-1"
      share={{
        status: 'not-shareable',
        reason: 'Local filesystem remotes cannot be published.',
      }}
    />,
  );

  expect(
    screen.getByText('Local filesystem remotes cannot be published.'),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /^share$/i }),
  ).not.toBeInTheDocument();
});

test('already-shared uses its existing share metadata', () => {
  render(
    <SkillShareSection
      skillId="skill-1"
      share={{
        status: 'already-shared',
        owner: 'stephentony100',
        slug: 'design-helper',
        url: SHARED_URL,
        versionNumber: 1,
      }}
    />,
  );

  expect(screen.getByText(/^shared$/i)).toBeInTheDocument();
  const link = screen.getByRole('link', { name: SHARED_URL });
  expect(link).toHaveAttribute('href', SHARED_URL);
});

test('update-available offers an Update shared version action using its existing slug', () => {
  render(
    <SkillShareSection
      skillId="skill-1"
      share={{
        status: 'update-available',
        owner: 'stephentony100',
        slug: 'design-helper',
        url: SHARED_URL,
        versionNumber: 1,
      }}
    />,
  );

  expect(
    screen.getByText(/update available to the shared version/i),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: /update shared version/i }),
  ).toBeInTheDocument();
});

test('portable-republish-needed uses its existing share metadata and offers an Update shared version action', () => {
  render(
    <SkillShareSection
      skillId="skill-1"
      share={{
        status: 'portable-republish-needed',
        owner: 'stephentony100',
        slug: 'design-helper',
        url: SHARED_URL,
        versionNumber: 1,
      }}
    />,
  );

  expect(screen.getByText(/portable republish needed/i)).toBeInTheDocument();
  const link = screen.getByRole('link', { name: SHARED_URL });
  expect(link).toHaveAttribute('href', SHARED_URL);
  expect(
    screen.getByRole('button', { name: /update shared version/i }),
  ).toBeInTheDocument();
});
