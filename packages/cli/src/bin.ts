#!/usr/bin/env node

import { StackStateError, StackStoreError } from '@stack/core';

import { createProgram } from './program.js';

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (error instanceof StackStateError || error instanceof StackStoreError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else throw error;
}
