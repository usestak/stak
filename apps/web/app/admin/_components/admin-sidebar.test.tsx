// apps/web/app/admin/_components/admin-sidebar.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AdminSidebar } from './admin-sidebar';

describe('AdminSidebar', () => {
  it('renders all seven nav links with the active one marked', () => {
    render(<AdminSidebar active="overview" />);
    const overviewLink = screen.getByRole('link', { name: 'Overview' });
    expect(overviewLink).toHaveClass('is-active');
    expect(screen.getByRole('link', { name: 'Users' })).not.toHaveClass(
      'is-active',
    );
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute(
      'href',
      '/admin/users',
    );
    expect(screen.getByRole('link', { name: 'Activation' })).toHaveAttribute(
      'href',
      '/admin/activation',
    );
    expect(screen.getByRole('link', { name: 'Usage' })).toHaveAttribute(
      'href',
      '/admin/usage',
    );
    expect(screen.getByRole('link', { name: 'Reliability' })).toHaveAttribute(
      'href',
      '/admin/reliability',
    );
    expect(screen.getByRole('link', { name: 'Feedback' })).toHaveAttribute(
      'href',
      '/admin/feedback',
    );
    expect(screen.getByRole('link', { name: 'System' })).toHaveAttribute(
      'href',
      '/admin/system',
    );
  });
});
