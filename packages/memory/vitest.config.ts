import { defineConfig } from 'vitest/config';

// These suites do a lot of temp-filesystem work (content-addressed store writes,
// atomic renames, byte-exact recovery) and crypto. Running the files serially
// within this package keeps them reliable under the monorepo's parallel test run
// on Windows, where many concurrent workers otherwise contend on the filesystem.
export default defineConfig({
  test: { fileParallelism: false },
});
