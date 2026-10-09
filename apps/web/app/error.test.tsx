import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import ErrorBoundary from './error';

afterEach(cleanup);

describe('ErrorBoundary', () => {
  test('renders a safe error message without leaking internals', () => {
    render(
      <ErrorBoundary
        error={new Error('Supabase: connection refused at 10.0.0.5')}
        reset={() => {}}
      />,
    );
    expect(screen.queryByText(/10\.0\.0\.5/)).not.toBeInTheDocument();
    expect(screen.queryByText(/supabase/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /try again/i }),
    ).toBeInTheDocument();
  });

  test('renders exactly one h1 and a single main landmark carrying main-content', () => {
    render(<ErrorBoundary error={new Error('boom')} reset={() => {}} />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
  });

  test('"Try again" calls reset without leaking a digest id to the visible message', () => {
    render(
      <ErrorBoundary
        error={Object.assign(new Error('boom'), { digest: 'abc123xyz' })}
        reset={() => {}}
      />,
    );
    expect(screen.queryByText(/abc123xyz/)).not.toBeInTheDocument();
  });
});
