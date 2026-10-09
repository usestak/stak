import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { FocusedShell } from './focused-shell';

afterEach(cleanup);

describe('FocusedShell', () => {
  test('renders exactly one h1 and a single main landmark carrying main-content', () => {
    render(
      <FocusedShell title="Sign in">
        <p>content</p>
      </FocusedShell>,
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
  });
});
