import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { NewStackForm } from './new-stack-form';

afterEach(cleanup);

const approvedSkills = [
  { skillId: 'skill-1', name: 'ByteRover', paused: false },
];

/** Regression for the live-acceptance finding: the "Next" gate on the name step must run
 *  the SAME schema the server validates against (userStackNameSchema), not a hand-picked
 *  subset — `main` was already blocked, but a leading `@` was not, letting the user
 *  progress to Skill selection with a name that would always be rejected on Create. */
test('the name step blocks "main" and "@"-prefixed names, and allows a normal name', () => {
  render(<NewStackForm approvedSkills={approvedSkills} />);

  const input = screen.getByPlaceholderText('e.g. frontend');
  const next = screen.getByRole('button', { name: /next: choose skills/i });

  fireEvent.change(input, { target: { value: 'main' } });
  expect(next).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent(/reserved/i);
  expect(screen.queryByText(/saved as/i)).not.toBeInTheDocument();

  fireEvent.change(input, { target: { value: 'MAIN' } });
  expect(next).toBeDisabled();
  expect(screen.queryByText(/saved as/i)).not.toBeInTheDocument();

  fireEvent.change(input, { target: { value: '@frontend' } });
  expect(next).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent(
    /reserved for public references/i,
  );
  expect(screen.queryByText(/saved as/i)).not.toBeInTheDocument();

  fireEvent.change(input, { target: { value: 'frontend' } });
  expect(next).toBeEnabled();
  expect(screen.getByText(/saved as/i)).toBeInTheDocument();
});

/** A disabled "Next" must be an actual disabled <button> (native click/keyboard
 *  blocking), not just dimmed via CSS — clicking it while invalid must never advance
 *  the step. */
test('a disabled "Next" button cannot be clicked past', () => {
  render(<NewStackForm approvedSkills={approvedSkills} />);

  const input = screen.getByPlaceholderText('e.g. frontend');
  fireEvent.change(input, { target: { value: '@frontend' } });

  const next = screen.getByRole('button', { name: /next: choose skills/i });
  expect(next).toHaveAttribute('disabled');
  fireEvent.click(next);
  expect(screen.getByPlaceholderText('e.g. frontend')).toBeInTheDocument();
  expect(
    screen.queryByRole('group', { name: 'Choose Skills' }),
  ).not.toBeInTheDocument();
});
