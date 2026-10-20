import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import BetaPage from './page';

afterEach(() => cleanup());

describe('/beta page', () => {
  it('surfaces the @beta install command and current version', () => {
    render(<BetaPage />);
    expect(screen.getByText('npm install -g @memstk/cli@beta')).toBeInTheDocument();
    expect(screen.getByText(/v0\.2\.0-beta\.1/)).toBeInTheDocument();
  });

  it('links to the feedback page', () => {
    render(<BetaPage />);
    expect(screen.getByRole('link', { name: /feedback/i })).toHaveAttribute('href', '/feedback');
  });

  it('does not overclaim memory portability across every agent', () => {
    render(<BetaPage />);
    expect(screen.queryByText(/memory.{0,20}every agent/i)).not.toBeInTheDocument();
  });
});
