import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { CliApprovalCard, CliApprovalShell } from './cli-approval-shell';

afterEach(cleanup);

describe('CliApprovalShell', () => {
  test('renders the real code in both panes and a single main landmark', () => {
    render(
      <CliApprovalShell code="KQTR-4821">
        <p>content</p>
      </CliApprovalShell>,
    );
    expect(screen.getAllByText('KQTR-4821').length).toBeGreaterThan(0);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
  });

  test('only shows the waiting/blinking-cursor line when waiting is true', () => {
    const { rerender } = render(
      <CliApprovalShell code="KQTR-4821">
        <p>content</p>
      </CliApprovalShell>,
    );
    expect(screen.queryByText(/Waiting/)).not.toBeInTheDocument();

    rerender(
      <CliApprovalShell code="KQTR-4821" waiting>
        <p>content</p>
      </CliApprovalShell>,
    );
    expect(screen.getByText(/Waiting/)).toBeInTheDocument();
  });

  test('renders no terminal status line at all when no code is given', () => {
    render(
      <CliApprovalShell>
        <p>content</p>
      </CliApprovalShell>,
    );
    expect(screen.queryByText(/Approve this machine in your browser/)).toBe(
      null,
    );
  });
});

describe('CliApprovalCard', () => {
  test('never renders a "Machine" or "System" row — no such real field exists', () => {
    render(
      <CliApprovalCard
        heading="Approve this machine?"
        code="KQTR-4821"
        label="temi-laptop"
      />,
    );
    expect(screen.queryByText('Machine')).toBe(null);
    expect(screen.queryByText('System')).toBe(null);
    expect(screen.getByText('Label')).toBeInTheDocument();
    expect(screen.getByText('temi-laptop')).toBeInTheDocument();
    expect(screen.getByText('KQTR-4821')).toBeInTheDocument();
  });

  test('omits the Label row entirely when the session has no label — never a blank row', () => {
    render(
      <CliApprovalCard heading="Approve this machine?" code="KQTR-4821" />,
    );
    expect(screen.queryByText('Label')).toBe(null);
    expect(screen.getByText('KQTR-4821')).toBeInTheDocument();
  });
});
