import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DOCS_NAV } from './docs-nav';

const appDir = path.dirname(fileURLToPath(import.meta.url));

describe('docs nav entries resolve to real routes', () => {
  for (const entry of DOCS_NAV) {
    it(`${entry.href} has a page.tsx`, () => {
      const routePath = entry.href === '/docs' ? '' : entry.href.replace('/docs/', '');
      const pageFile = path.join(appDir, routePath, 'page.tsx');
      expect(existsSync(pageFile)).toBe(true);
    });
  }
});

describe('sidebar links to real Docs and CLI Reference routes', () => {
  it('app-sidebar.tsx has separate Docs and CLI Reference links, not a combined span', () => {
    const sidebar = readFileSync(
      path.join(appDir, '../_components/app-sidebar.tsx'),
      'utf8',
    );
    expect(sidebar).not.toContain('Docs · CLI reference');
    expect(sidebar).toContain("href=\"/docs\"");
    expect(sidebar).toContain("href=\"/docs/cli\"");
  });
});
