import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import BetaPage from './page';

afterEach(() => cleanup());

describe('/beta page', () => {
  it('surfaces the @beta install command and current version', () => {
    render(<BetaPage />);
    expect(
      screen.getByText('npm install -g @memstk/cli@beta'),
    ).toBeInTheDocument();
    expect(screen.getByText(/v0\.2\.0-beta\.1/)).toBeInTheDocument();
  });

  it('links to the feedback page', () => {
    render(<BetaPage />);
    // "Feedback" also appears as a footer link now (site-wide chrome), so
    // scope to the page's own CTA rather than asserting a single match.
    const links = screen.getAllByRole('link', { name: /feedback/i });
    expect(links.some((l) => l.getAttribute('href') === '/feedback')).toBe(
      true,
    );
  });

  it('does not overclaim memory portability across every agent', () => {
    render(<BetaPage />);
    expect(
      screen.queryByText(/memory.{0,20}every agent/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'During the public beta, Project Memory portability supports Claude Code.',
      ),
    ).toBeInTheDocument();
  });
});
