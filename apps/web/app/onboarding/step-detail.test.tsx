import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { renderStepDetail } from './step-detail';

afterEach(cleanup);

test('renderStepDetail turns every backtick-quoted command into a real InlineCommand button', () => {
  render(
    <div>
      {renderStepDetail(
        'Run `stak login` and approve it here in your browser.',
      )}
    </div>,
  );
  expect(
    screen.getByRole('button', { name: 'Copy stak login' }),
  ).toBeInTheDocument();
  expect(screen.getByText('Run', { exact: false })).toBeInTheDocument();
});

test('renderStepDetail renders plain text unchanged when there are no backticks', () => {
  render(
    <div>
      {renderStepDetail(
        'Sign in on another machine later to bring your STAK and Memory with you.',
      )}
    </div>,
  );
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(
    screen.getByText(/bring your STAK and Memory with you/),
  ).toBeInTheDocument();
});
