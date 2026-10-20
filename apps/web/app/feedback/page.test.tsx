import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import FeedbackPage from './page';

describe('/feedback page', () => {
  it('renders the feedback form', () => {
    render(<FeedbackPage />);
    expect(
      screen.getByRole('heading', { name: /feedback/i }),
    ).toBeInTheDocument();
  });
});
