import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FeedbackForm } from './feedback-form';

describe('FeedbackForm', () => {
  it('submits the selected type and message, then shows a calm confirmation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 202, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<FeedbackForm />);
    await userEvent.selectOptions(screen.getByLabelText(/type/i), 'idea');
    await userEvent.type(
      screen.getByLabelText(/what happened, or what would you change/i),
      'Add a dark mode toggle.',
    );
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/thanks\. this directly helps shape the public beta/i)).toBeInTheDocument(),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/feedback',
      expect.objectContaining({ method: 'POST' }),
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody).toMatchObject({ type: 'idea', message: 'Add a dark mode toggle.' });
  });

  it('shows the privacy note about credentials and secrets', () => {
    render(<FeedbackForm />);
    expect(
      screen.getByText(/don't include credentials, secrets, or private memory content/i),
    ).toBeInTheDocument();
  });
});
