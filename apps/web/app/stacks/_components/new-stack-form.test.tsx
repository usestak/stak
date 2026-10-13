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

  fireEvent.change(input, { target: { value: 'MAIN' } });
  expect(next).toBeDisabled();

  fireEvent.change(input, { target: { value: '@frontend' } });
  expect(next).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent(
    /reserved for public references/i,
  );

  fireEvent.change(input, { target: { value: 'frontend' } });
  expect(next).toBeEnabled();
});
