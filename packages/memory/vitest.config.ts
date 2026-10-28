import { defineConfig } from 'vitest/config';

// These suites do a lot of temp-filesystem work (content-addressed store writes,
// atomic renames, byte-exact recovery) and crypto. Running the files serially
// within this package keeps them reliable under the monorepo's parallel test run
// on Windows, where many concurrent workers otherwise contend on the filesystem.
// The 30 s per-test budget matches the other filesystem-heavy packages (cli, core,
// store, adapters): vitest's 5 s default is too tight for a byte-exact backup and
// recovery of a synthetic store on a Windows CI runner during the full parallel run.
export default defineConfig({
  test: { fileParallelism: false, testTimeout: 30000, hookTimeout: 30000 },
});
