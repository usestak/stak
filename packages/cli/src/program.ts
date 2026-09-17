import { createRequire } from 'node:module';

import { Command } from 'commander';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json') as { version: string };

export const createProgram = (): Command =>
  new Command()
    .name('stack')
    .description('The control plane for portable AI agent environments.')
    .version(packageMetadata.version);
