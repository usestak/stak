import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { SkipLink } from './skip-link';

afterEach(cleanup);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('SkipLink', () => {
  test('targets main-content and is the first focusable element', () => {
    render(
      <>
        <SkipLink />
        <nav>
          <a href="/x">x</a>
        </nav>
        <main id="main-content">content</main>
      </>,
    );
    const link = screen.getByRole('link', { name: /skip to main content/i });
    expect(link).toHaveAttribute('href', '#main-content');
  });

  test('is the first element in tab order', () => {
    render(
      <>
        <SkipLink />
        <nav>
          <a href="/x">x</a>
        </nav>
        <main id="main-content">content</main>
      </>,
    );
    const focusable = screen.getAllByRole('link');
    expect(focusable[0]).toHaveAccessibleName(/skip to main content/i);
  });

  test('hardcoded skip-link colors in globals.css stay in sync with shell.css .stak tokens', () => {
    // The skip link renders outside the `.stak` CSS custom-property scope (see comment above
    // `.stak-skip-link` in globals.css), so it can't reference var(--bg)/var(--ink)/var(--orange)
    // directly — those literal hex copies must be kept manually in sync with shell.css's `.stak`
    // block. This test is the tripwire: if shell.css's tokens change without updating the
    // skip-link copy, this fails instead of silently going stale.
    const globalsCssPath = path.join(__dirname, '..', 'globals.css');
    const shellCssPath = path.join(__dirname, '..', 'overview', 'shell.css');

    const globalsCss = readFileSync(globalsCssPath, 'utf-8');
    const shellCss = readFileSync(shellCssPath, 'utf-8');

    const stakBlockMatch = shellCss.match(/\.stak\s*\{([\s\S]*?)\n\}/);
    expect(stakBlockMatch).not.toBeNull();
    const stakBlock = stakBlockMatch![1];

    function extractToken(block: string, name: string): string {
      const match = block.match(
        new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8});`),
      );
      expect(
        match,
        `expected --${name} to be defined in .stak block`,
      ).not.toBeNull();
      return match![1].toLowerCase();
    }

    const shellBg = extractToken(stakBlock, 'bg');
    const shellInk = extractToken(stakBlock, 'ink');
    const shellOrange = extractToken(stakBlock, 'orange');

    const skipLinkBlockMatch = globalsCss.match(
      /\.stak-skip-link\s*\{([\s\S]*?)\n\}/,
    );
    expect(skipLinkBlockMatch).not.toBeNull();
    const skipLinkBlock = skipLinkBlockMatch![1];

    const skipLinkFocusBlockMatch = globalsCss.match(
      /\.stak-skip-link:focus\s*\{([\s\S]*?)\n\}/,
    );
    expect(skipLinkFocusBlockMatch).not.toBeNull();
    const skipLinkFocusBlock = skipLinkFocusBlockMatch![1];

    const skipLinkBg = skipLinkBlock
      .match(/background:\s*(#[0-9a-fA-F]{3,8});/)?.[1]
      .toLowerCase();
    const skipLinkInk = skipLinkBlock
      .match(/color:\s*(#[0-9a-fA-F]{3,8});/)?.[1]
      .toLowerCase();
    const skipLinkBorderOrange = skipLinkBlock
      .match(/border:\s*2px solid\s*(#[0-9a-fA-F]{3,8});/)?.[1]
      .toLowerCase();
    const skipLinkOutlineOrange = skipLinkFocusBlock
      .match(/outline:\s*2px solid\s*(#[0-9a-fA-F]{3,8});/)?.[1]
      .toLowerCase();

    expect(skipLinkBg).toBe(shellBg);
    expect(skipLinkInk).toBe(shellInk);
    expect(skipLinkBorderOrange).toBe(shellOrange);
    expect(skipLinkOutlineOrange).toBe(shellOrange);
  });
});
