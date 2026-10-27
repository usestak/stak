#!/usr/bin/env node

import { createProgram } from './program.js';
import { formatCliError, isRenderableCliError } from './ui/errors.js';

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (isRenderableCliError(error)) {
    process.stderr.write(
      `${formatCliError(error, { verbose: process.argv.includes('--verbose') })}\n`,
    );
    process.exitCode = 1;
  } else throw error;
}
