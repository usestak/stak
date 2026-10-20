import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { FeedbackForm } from './feedback-form';

describe('FeedbackForm', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });
  it('submits the selected type and message, then shows a calm confirmation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<FeedbackForm />);
    const typeSelect = container.querySelector(
      '#feedback-type',
    ) as HTMLSelectElement;
    const messageTextarea = container.querySelector(
      '#feedback-message',
    ) as HTMLTextAreaElement;
    const submitButton = container.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;

    await userEvent.selectOptions(typeSelect, 'idea');
    await userEvent.type(messageTextarea, 'Add a dark mode toggle.');
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        'Thanks. This directly helps shape the public beta.',
      );
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/feedback',
      expect.objectContaining({ method: 'POST' }),
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody).toMatchObject({
      type: 'idea',
      message: 'Add a dark mode toggle.',
    });
  });

  it('shows the privacy note about credentials and secrets', () => {
    const { container } = render(<FeedbackForm />);
    const privacyNote = container.querySelector('p:last-of-type');
    expect(privacyNote?.textContent).toBe(
      "Please don't include credentials, secrets, or private Memory content.",
    );
  });

  it('has the correct label for the message field', () => {
    const { container } = render(<FeedbackForm />);
    const label = container.querySelector('label[for="feedback-message"]');
    expect(label?.textContent).toBe('What happened, or what would you change?');
  });

  it('shows error message when feedback submission fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ ok: false }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<FeedbackForm />);
    const messageTextarea = container.querySelector(
      '#feedback-message',
    ) as HTMLTextAreaElement;
    const submitButton = container.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;

    await userEvent.type(messageTextarea, 'Test message');
    await userEvent.click(submitButton);

    await waitFor(() => {
      const alertElement = container.querySelector('[role="alert"]');
      expect(alertElement).toHaveTextContent(
        'Something went wrong. Try again.',
      );
    });
  });

  it('includes pageUrl in the submitted feedback body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<FeedbackForm />);
    const messageTextarea = container.querySelector(
      '#feedback-message',
    ) as HTMLTextAreaElement;
    const submitButton = container.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;

    await userEvent.type(messageTextarea, 'Test feedback');
    await userEvent.click(submitButton);

    await waitFor(() => {
      const statusElement = container.querySelector('[role="status"]');
      expect(statusElement?.textContent).toBe(
        'Thanks. This directly helps shape the public beta.',
      );
    });

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.pageUrl).toBeDefined();
  });
});
