import { defineConfig } from 'vitest/config';

// Serialize files within this spike package: it does temp-filesystem work plus
// memory-hard scrypt (recovery-key), which under the monorepo's parallel test run
// on Windows can otherwise contend for filesystem handles and RAM.
export default defineConfig({
  test: { fileParallelism: false },
});
