import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import OwnerNotFound from './not-found';

afterEach(cleanup);

describe('Public owner/stack NotFound', () => {
  test('renders a clear not-found message using the public shell (no sidebar, no internals)', () => {
    render(<OwnerNotFound />);
    expect(screen.getByText(/not found/i)).toBeInTheDocument();
    // PublicShell's nav is labelled "STAK", never the signed-in AppSidebar's "Primary" nav.
    expect(
      screen.getByRole('navigation', { name: 'STAK' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument();
  });

  test('renders exactly one h1 and a single main landmark carrying main-content', () => {
    render(<OwnerNotFound />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
  });

  test('offers a safe next action back to a known destination', () => {
    render(<OwnerNotFound />);
    const link = screen.getByRole('link', { name: /go to stak home/i });
    expect(link).toHaveAttribute('href', '/');
  });
});
