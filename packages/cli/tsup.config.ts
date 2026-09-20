import { defineConfig } from 'tsup';

// Bundle the CLI into a single self-contained ESM binary so the published
// package does not depend on pnpm workspace links or unpublished @stack/*
// packages. Node built-ins remain external automatically.
export default defineConfig({
  entry: { bin: 'src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  clean: true,
  dts: false,
  sourcemap: false,
  splitting: false,
  shims: false,
  noExternal: [/.*/],
  // Provide a real `require` so bundled CJS deps (e.g. yaml) can require Node
  // built-ins under ESM output instead of hitting esbuild's dynamic-require shim.
  banner: {
    js: "import { createRequire as __stackCreateRequire } from 'node:module'; const require = __stackCreateRequire(import.meta.url);",
  },
});
