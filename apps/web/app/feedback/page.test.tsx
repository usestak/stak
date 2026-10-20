import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import FeedbackPage from './page';

describe('/feedback page', () => {
  it('renders the feedback form inside the page heading and site chrome', () => {
    render(<FeedbackPage />);
    // The page uses an eyebrow label ("FEEDBACK") above a distinct <h1>,
    // matching /beta's hero pattern, rather than a literal "Feedback" h1.
    expect(
      screen.getByRole('heading', {
        name: 'Help us make STAK easier to use.',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('FEEDBACK')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Send feedback' }),
    ).toBeInTheDocument();
  });
});
