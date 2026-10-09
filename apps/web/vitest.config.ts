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
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
});
