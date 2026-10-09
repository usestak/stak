import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { PublicShell } from './public-shell';

afterEach(cleanup);

describe('PublicShell', () => {
  test('renders exactly one h1 and a main landmark', () => {
    render(
      <PublicShell title="demo-stack by alice">
        <p>content</p>
      </PublicShell>,
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  test('does not render signed-in account affordances', () => {
    render(
      <PublicShell title="demo-stack by alice">
        <p>content</p>
      </PublicShell>,
    );
    expect(
      screen.queryByRole('button', { name: /sign out/i }),
    ).not.toBeInTheDocument();
  });

  test('renders a nav landmark with a link back to the STAK homepage', () => {
    render(
      <PublicShell title="demo-stack by alice">
        <p>content</p>
      </PublicShell>,
    );
    const nav = screen.getByRole('navigation');
    const link = screen.getByRole('link', { name: 'STAK' });
    expect(nav).toContainElement(link);
    expect(link).toHaveAttribute('href', '/');
  });

  test('renders a footer landmark', () => {
    render(
      <PublicShell title="demo-stack by alice">
        <p>content</p>
      </PublicShell>,
    );
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });
});
