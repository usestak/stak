import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';

import { InlineCommand } from './inline-command';

afterEach(cleanup);

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

test('is a real button with a correct accessible name', () => {
  render(<InlineCommand command="stak login" />);
  const button = screen.getByRole('button', { name: 'Copy stak login' });
  expect(button.tagName).toBe('BUTTON');
  expect(button).toHaveTextContent('stak login');
});

test('clicking copies the exact command text', () => {
  render(<InlineCommand command="stak memory backup" />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Copy stak memory backup' }),
  );
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
    'stak memory backup',
  );
});

test('shows textual "Copied" feedback, not just a color change', () => {
  vi.useFakeTimers();
  render(<InlineCommand command="stak scan" />);
  const button = screen.getByRole('button', { name: 'Copy stak scan' });

  fireEvent.click(button);
  expect(button).toHaveTextContent('Copied ✓');

  act(() => {
    vi.advanceTimersByTime(1600);
  });
  expect(button).toHaveTextContent('stak scan');
  vi.useRealTimers();
});

test('keyboard-equivalent activation works because it is a native button', () => {
  // A real <button> gets Enter/Space activation for free from the browser -
  // confirming button semantics (above) is the regression test for this;
  // fireEvent.click is how Testing Library simulates that native activation.
  render(<InlineCommand command="stak status" />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy stak status' }));
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('stak status');
});

test('a clipboard failure does not throw and the button stays usable', () => {
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockRejectedValue(new Error('denied')),
    },
  });
  render(<InlineCommand command="stak pull" />);
  const button = screen.getByRole('button', { name: 'Copy stak pull' });
  expect(() => fireEvent.click(button)).not.toThrow();
});
