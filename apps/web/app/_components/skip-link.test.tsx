import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { SkipLink } from './skip-link';

afterEach(cleanup);

describe('SkipLink', () => {
  test('targets main-content and is the first focusable element', () => {
    render(
      <>
        <SkipLink />
        <nav>
          <a href="/x">x</a>
        </nav>
        <main id="main-content">content</main>
      </>,
    );
    const link = screen.getByRole('link', { name: /skip to main content/i });
    expect(link).toHaveAttribute('href', '#main-content');
  });

  test('is the first element in tab order', () => {
    render(
      <>
        <SkipLink />
        <nav>
          <a href="/x">x</a>
        </nav>
        <main id="main-content">content</main>
      </>,
    );
    const focusable = screen.getAllByRole('link');
    expect(focusable[0]).toHaveAccessibleName(/skip to main content/i);
  });
});
