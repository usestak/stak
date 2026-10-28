import { defineConfig } from 'vitest/config';

// Serialize files within this spike package: it does temp-filesystem work plus
// memory-hard scrypt (recovery-key), which under the monorepo's parallel test run
// on Windows can otherwise contend for filesystem handles and RAM.
// The 30 s per-test budget matches the other filesystem-heavy packages (cli, core,
// store, adapters): vitest's 5 s default is too tight for a byte-exact backup and
// recovery of a synthetic store on a Windows CI runner during the full parallel run.
export default defineConfig({
  test: { fileParallelism: false, testTimeout: 30000, hookTimeout: 30000 },
});
