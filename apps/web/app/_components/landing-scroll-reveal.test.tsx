import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { PublicLandingShell } from './public-landing-shell';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// P9 Task 3, manual-verification note (brief step 4): this is the
// automated half of reduced-motion verification. The other half was done
// by hand in a real browser with the OS "Reduce motion" setting on and
// DevTools' "Emulate CSS prefers-reduced-motion: reduce" (see the task
// report) - confirming visually that the hero/preview entrance and the
// scroll-reveal sections render fully settled with no animation, and that
// the Copy button's "Copied" confirmation still appears (near-instant).
//
// This test covers the part jsdom *can* assert: content is immediately
// present and readable regardless of IntersectionObserver support or the
// reduced-motion media query, because `LandingScrollReveal` never hides
// anything itself - it only ever adds a class, and only when motion is
// actually allowed to run.
test('landing content is fully present with no IntersectionObserver support (default jsdom)', () => {
  // jsdom has no IntersectionObserver by default - this is exactly the
  // "script runs, but the API isn't supported" case the component guards.
  expect((window as unknown as Record<string, unknown>).IntersectionObserver).toBeUndefined();

  render(<PublicLandingShell />);

  // SEO-critical hero text and below-the-fold explainer copy are all
  // present with no JS-driven gating.
  expect(
    screen.getByRole('heading', {
      level: 1,
      name: 'Your STAK should survive your laptop.',
    }),
  ).toBeInTheDocument();
  expect(screen.getByText('Skills you can inspect')).toBeInTheDocument();
  expect(
    screen.getByRole('heading', { level: 2, name: 'How it works' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('heading', { level: 2, name: 'Memory & privacy' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('heading', { level: 2, name: 'Move to a new machine' }),
  ).toBeInTheDocument();
  expect(
    screen.getByText('Each machine catches up on its next CLI run there.'),
  ).toBeInTheDocument();

  // No [data-reveal] section was ever hidden - the component couldn't add
  // its "armed" class because the API isn't there.
  const revealed = document.querySelectorAll('[data-reveal]');
  expect(revealed.length).toBeGreaterThan(0);
  revealed.forEach((el) => {
    expect(el.classList.contains('stak-reveal-armed')).toBe(false);
  });
});

test('reduced motion: sections are never armed even when IntersectionObserver is available', () => {
  class FakeIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  // Simulate the OS/browser "reduce motion" setting.
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );

  render(<PublicLandingShell />);

  expect(
    screen.getByRole('heading', {
      level: 1,
      name: 'Your STAK should survive your laptop.',
    }),
  ).toBeInTheDocument();

  const revealed = document.querySelectorAll('[data-reveal]');
  expect(revealed.length).toBeGreaterThan(0);
  revealed.forEach((el) => {
    expect(el.classList.contains('stak-reveal-armed')).toBe(false);
  });
});
