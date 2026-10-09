import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import NotFound from './not-found';

afterEach(cleanup);

describe('NotFound', () => {
  test('renders a clear not-found message with a safe next action', () => {
    render(<NotFound />);
    expect(screen.getByText(/not found/i)).toBeInTheDocument();
    expect(screen.getByRole('link')).toBeInTheDocument();
  });

  test('renders exactly one h1 and a single main landmark carrying main-content', () => {
    render(<NotFound />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
  });

  test('the next action leads back to a safe, known destination', () => {
    render(<NotFound />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/');
  });
});
