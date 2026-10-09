import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CommandDock } from './command-dock';

afterEach(cleanup);

// jsdom has no clipboard API by default; stub it so `copy` doesn't throw inside the
// component's try/catch (the catch would otherwise swallow a real failure silently).
beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe('CommandDock', () => {
  test('ready-to-run command exposes a reachable Copy button with accessible name', () => {
    render(
      <CommandDock machineName="Atlas" command="stak scan" kind="ready" />,
    );
    expect(
      screen.getByRole('button', { name: /copy command/i }),
    ).toBeInTheDocument();
  });

  test('defaults to ready (no template badge) when kind is omitted', () => {
    render(<CommandDock machineName="Atlas" command="stak scan" />);
    expect(screen.queryByText(/template/i)).not.toBeInTheDocument();
  });

  test('template command is visually and semantically distinguished from a ready command', () => {
    render(
      <CommandDock
        machineName="Atlas"
        command="stak project map atlas/stak <directory>"
        kind="template"
      />,
    );
    expect(screen.getByText(/template/i)).toBeInTheDocument();
    // Still reachable: a template is copy-able, just clearly labeled as needing edits first.
    expect(
      screen.getByRole('button', { name: /copy command/i }),
    ).toBeInTheDocument();
  });

  test('ready command never renders a template label', () => {
    render(
      <CommandDock machineName="Atlas" command="stak scan" kind="ready" />,
    );
    expect(screen.queryByText(/template/i)).not.toBeInTheDocument();
  });
});
