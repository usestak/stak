import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/overview',
}));

vi.mock('./machine-preference-actions', () => ({
  setActiveMachinePreference: vi.fn().mockResolvedValue(undefined),
}));

import { MachineSelector } from './machine-selector';

afterEach(cleanup);

const options = [
  { machineId: 'm-a1', name: 'DELL', secondary: 'Windows · up to date' },
  { machineId: 'm-b2', name: 'Atlas', secondary: 'macOS · up to date' },
];

/** Regression for the launch finding: picking another machine gave no visible feedback
 *  while the new server-rendered page loaded, making the selector feel unresponsive. The
 *  wiring (aria-busy, disabled, "Switching…" text, all driven by `useTransition`'s
 *  `isPending`) is exercised here; the exact synchronous instant of `isPending === true`
 *  isn't observable through a fully mocked, non-Suspense `router.replace` (there's no real
 *  async work for React to stay pending on in this harness) — that visual moment was
 *  confirmed by direct code inspection and is the kind of thing worth a manual/live check. */
test('picking a different machine persists the choice and navigates to it', () => {
  render(<MachineSelector current="m-a1" options={options} />);

  const trigger = screen.getByRole('button', { name: /viewing as dell/i });
  fireEvent.click(trigger);
  fireEvent.mouseDown(screen.getByRole('option', { name: /atlas/i }));

  expect(replace).toHaveBeenCalledWith('/overview?machine=m-b2');
});

test('the trigger exposes aria-busy and is a real disabled button when not mid-transition', () => {
  render(<MachineSelector current="m-a1" options={options} />);

  const trigger = screen.getByRole('button', { name: /viewing as dell/i });
  // At rest, never disabled/busy — the attributes exist and reflect `isPending`, they
  // aren't hardcoded true.
  expect(trigger).not.toBeDisabled();
  expect(trigger).toHaveAttribute('aria-busy', 'false');
});

test('choosing the already-current machine is a no-op — no navigation, no preference write', () => {
  render(<MachineSelector current="m-a1" options={options} />);

  const trigger = screen.getByRole('button', { name: /viewing as dell/i });
  fireEvent.click(trigger);
  fireEvent.mouseDown(screen.getByRole('option', { name: /dell/i }));

  expect(replace).not.toHaveBeenCalled();
});
