import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const updateUserStackAction = vi.fn();
vi.mock('../actions', () => ({
  updateUserStackAction: (...args: unknown[]) => updateUserStackAction(...args),
  publishUserStackAction: vi.fn(),
  unpublishUserStackAction: vi.fn(),
  getUserStackPublicationStatusAction: vi.fn(),
}));

import { EditStakForm } from './edit-stak-form';

afterEach(cleanup);

const detail = {
  stackId: 'stack-1',
  name: 'frontend-test',
  description: 'A small frontend STAK for testing public sharing.',
  skills: [],
  version: {
    versionId: 'v1',
    versionNumber: 1,
    createdAt: '2026-01-01T00:00:00Z',
  },
};
const approvedSkills = [
  { skillId: 'skill-1', name: 'ByteRover', paused: false },
];

/** Regression for the known gap this task fixes: the private detail/edit page received
 *  `description` from the server (it's always present in UserStackDetail) but never
 *  rendered or let the user edit it. */
test('the edit form shows the STAK description and lets it be edited', () => {
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{ status: 'private' }}
    />,
  );

  const input = screen.getByPlaceholderText('What this STAK is for');
  expect(input).toHaveValue(detail.description);
});

test('saving only sends description when it actually changed', async () => {
  updateUserStackAction.mockResolvedValue({ ok: true, versionNumber: 2 });
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{ status: 'private' }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /review changes/i }));
  fireEvent.click(screen.getByRole('button', { name: /save as new version/i }));

  expect(updateUserStackAction).toHaveBeenCalledWith(
    expect.not.objectContaining({ description: expect.anything() }),
  );
});

test('editing the description includes it in the save payload', async () => {
  updateUserStackAction.mockResolvedValue({ ok: true, versionNumber: 2 });
  render(
    <EditStakForm
      detail={detail}
      approvedSkills={approvedSkills}
      initialPublication={{ status: 'private' }}
    />,
  );

  fireEvent.change(screen.getByPlaceholderText('What this STAK is for'), {
    target: { value: 'Updated description.' },
  });
  fireEvent.click(screen.getByRole('button', { name: /review changes/i }));
  expect(screen.getByText('Updated description.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /save as new version/i }));

  expect(updateUserStackAction).toHaveBeenCalledWith(
    expect.objectContaining({ description: 'Updated description.' }),
  );
});
