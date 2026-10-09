import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ProjectsTable } from './projects-table';
import type { ProjectRow } from '../projects-data';

// ProjectsTable renders ProjectLifecycleButton, a client component that calls
// next/navigation's useRouter and a server action. Those require more context than
// a unit test needs, so stub them.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('../actions', () => ({
  setProjectLifecycleAction: vi.fn(),
}));

afterEach(cleanup);

const row: ProjectRow = {
  projectId: 'project-1',
  name: 'stak-cloud',
  lifecycle: 'active',
  lifecycleLabel: 'Active',
  presence: 'On this machine',
  fileCountLabel: '42 files',
  cliSelector: 'stak-cloud',
};

test('each stacked row exposes a per-field accessible label alongside its value', () => {
  render(<ProjectsTable rows={[row]} machineName="dell" />);

  // The visual header (PROJECT/LIFECYCLE/ON DELL/MEMORY) is hidden below 768px via CSS, so a
  // screen-reader user must get field meaning from the row itself.
  expect(screen.getByText(/Project:/i)).toBeInTheDocument();
  expect(screen.getByText(/Lifecycle:/i)).toBeInTheDocument();
  expect(screen.getByText(/On dell:/i)).toBeInTheDocument();
  expect(screen.getByText(/Memory:/i)).toBeInTheDocument();

  const nameLink = screen.getByRole('link', { name: /stak-cloud/i });
  expect(nameLink).toHaveAccessibleName(/Project:\s*stak-cloud/i);

  const lifecycleField = screen.getByText('Active').closest('span');
  expect(lifecycleField).toHaveTextContent(/Lifecycle:\s*Active/i);

  const presenceField = screen.getByText('On this machine').closest('span');
  expect(presenceField).toHaveTextContent(/On dell:\s*On this machine/i);

  const memoryField = screen.getByText('42 files').closest('span');
  expect(memoryField).toHaveTextContent(/Memory:\s*42 files/i);

  // Frozen vocabulary strings must not be rephrased.
  expect(screen.getByText('Active')).toBeInTheDocument();
  expect(screen.getByText('On this machine')).toBeInTheDocument();
});
