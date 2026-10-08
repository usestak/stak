import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Brand guard for the web UI (Phase R4). Pages are React Server Components with no
 * render-test harness, so these checks read the source of `apps/web/app` and assert the
 * user-visible product brand is STAK while the reusable domain object stays a "stack".
 * Kept to small, stable substrings so it is not a brittle marketing-copy snapshot.
 */
const appDir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(appDir, rel), 'utf8');

const allSources = (): string => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx?|css)$/.test(entry) && !entry.endsWith('.test.ts'))
        out.push(readFileSync(full, 'utf8'));
    }
  };
  walk(appDir);
  return out.join('\n');
};

describe('web product branding is STAK (R4)', () => {
  it('root metadata title uses STAK', () => {
    expect(read('layout.tsx')).toContain("title: 'STAK Cloud'");
  });

  it('site header wordmark and landing hero use STAK', () => {
    const header = read('_components/site-header.tsx');
    expect(header).toContain('STAK');
    // P8: the signed-in product now lives entirely behind AppSidebar; this
    // header's nav only needs to land a signed-in visitor on their Overview.
    expect(header).toContain('>Overview<');
    const landing = read('page.tsx');
    expect(landing).toContain('STAK Cloud');
    expect(landing).toContain('Your STAK');
  });

  it('CLI authorization uses STAK CLI', () => {
    expect(read('cli/page.tsx')).toContain('Authorize the STAK CLI');
  });

  it('Memory protect/recover visible copy uses STAK Memory', () => {
    expect(read('memory/protect/page.tsx')).toContain('STAK Memory');
    expect(read('memory/recover/page.tsx')).toContain('STAK Memory');
  });

  it('no user-visible product-brand "Stack Cloud/CLI/Memory" remains in the UI', () => {
    const sources = allSources();
    expect(sources).not.toContain('Stack Cloud');
    expect(sources).not.toContain('Stack CLI');
    expect(sources).not.toContain('Stack Memory');
  });

  it('domain-object "stack" terminology is preserved', () => {
    const sources = allSources();
    expect(sources).toContain('Public Stacks'); // owner page (object, plural)
    expect(sources).toContain('This Stack'); // object noun preserved
    expect(sources).toContain('stak use'); // product verb `stak` + object
  });

  it('internal @stack/* imports are untouched', () => {
    expect(allSources()).toContain('@stack/');
  });

  it('no stale "stack <command>" executable invocations remain in the UI', () => {
    const sources = allSources();
    for (const invocation of [
      'stack login',
      'stack push',
      'stack logout',
      'stack memory',
    ])
      expect(sources).not.toContain(invocation);
  });
});
