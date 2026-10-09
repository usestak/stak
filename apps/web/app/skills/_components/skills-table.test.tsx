import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { SkillsTable } from './skills-table';
import type { SkillRow } from '../skills-data';

afterEach(cleanup);

const row: SkillRow = {
  skillId: 'skill-1',
  name: 'ByteRover',
  description: 'Context memory for agents',
  sourcePrimary: 'github.com/byterover/cipher',
  sourceSecondary: 'v1.2.0',
  sourceCheckNote: undefined,
  reviewNote: undefined,
  reconciliationState: 'installed',
  reconciliationLabel: 'Installed',
  installedShortHash: 'abc12345',
  primaryStatus: 'ready',
  pendingInstall: false,
  dot: 'ready',
  statusText: 'Ready',
  cliSelector: 'byterover',
};

test('each stacked row exposes a per-field accessible label alongside its value', () => {
  render(<SkillsTable rows={[row]} machineName="dell" />);

  // The visual header (SKILL/SOURCE/ON DELL/STATUS) is hidden below 768px via CSS, so a
  // screen-reader user must get field meaning from the row itself. Verify each field's
  // sr-only label text is present in the DOM, and that the row's accessible name pairs the
  // label with its value (not just the bare value).
  const link = screen.getByRole('link', { name: /ByteRover/i });

  expect(link).toHaveAccessibleName(/Skill:\s*ByteRover/i);
  expect(link).toHaveAccessibleName(/Source:\s*github\.com\/byterover\/cipher/i);
  expect(link).toHaveAccessibleName(/On dell:\s*Installed/i);
  expect(link).toHaveAccessibleName(/Status:\s*Ready/i);

  // Frozen vocabulary strings must not be rephrased.
  expect(screen.getByText('Ready')).toBeInTheDocument();
  expect(screen.getByText('Installed')).toBeInTheDocument();
});

test('a truly empty Skills dataset renders no filter/search/table chrome, only the empty message', () => {
  render(<SkillsTable rows={[]} machineName="dell" />);

  expect(screen.getByText(/no skills in stak yet/i)).toBeInTheDocument();
  expect(
    screen.queryByRole('group', { name: /filter skills/i }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('searchbox', { name: /search skills/i }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('row')).not.toBeInTheDocument();
});
