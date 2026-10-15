import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * apps/web test config (P9 Task 1): adds a jsdom environment on top of the repo
 * default so component tests (React Testing Library) can render and interact
 * with DOM nodes. Non-component tests (e.g. branding.test.ts) run fine under
 * jsdom too, so there is no need to split environments per-file.
 */
export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./*" path mapping. Several route/lib
    // files already import via this alias (it's the Next build's own
    // convention); without it here, any test that imports such a file fails
    // to resolve under Vitest even though the real app builds fine.
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
});
