import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Resolved via cwd rather than `import.meta.url` + `fileURLToPath`: on Windows, vitest's
// `import.meta.url` here is a bare drive-letter path (e.g. "C:/Users/..."), and the WHATWG
// URL parser reads the "C:" prefix as the URL *scheme*, not a file-scheme path — so
// `fileURLToPath(new URL('./x.ts', import.meta.url))` throws "The URL must be of scheme
// file". `pnpm --filter web test` always runs with apps/web as the working directory.
const SOURCE_PATH = path.join(process.cwd(), 'lib', 'supabase-browser.ts');

describe('supabase-browser source', () => {
  it('never references server-only secrets by name', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    expect(source).not.toMatch(
      /SUPABASE_SERVICE_ROLE_KEY|STAK_TICKET_SECRET|STACK_TICKET_SECRET|serviceRoleKey|ticketSecret/,
    );
  });

  it('never imports cloudEnv, which reads those secrets eagerly', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    expect(source).not.toMatch(/cloudEnv/);
  });
});

describe('createSupabaseBrowserClient', () => {
  const ORIGINAL_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const ORIGINAL_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@supabase/ssr');
    process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ORIGINAL_ANON_KEY;
  });

  it('calls createBrowserClient with the two public env vars', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';

    const createBrowserClient = vi.fn(() => ({ mocked: true }));
    vi.doMock('@supabase/ssr', () => ({ createBrowserClient }));

    const { createSupabaseBrowserClient } = await import('./supabase-browser');
    createSupabaseBrowserClient();

    expect(createBrowserClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'anon-key-value',
    );
  });

  it('throws a clear error if either public env var is missing', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';
    vi.doMock('@supabase/ssr', () => ({ createBrowserClient: vi.fn() }));

    const { createSupabaseBrowserClient } = await import('./supabase-browser');
    expect(() => createSupabaseBrowserClient()).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL/,
    );
  });
});
