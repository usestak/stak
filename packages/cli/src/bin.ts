#!/usr/bin/env node

import {
  StackCompositionError,
  StackStateError,
  StackStoreError,
} from '@stack/core';
import { StackAdapterError } from '@stack/adapters';
import { StackCloudError } from '@stack/cloud-client';

import { createProgram } from './program.js';

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (
    error instanceof StackStateError ||
    error instanceof StackStoreError ||
    error instanceof StackCompositionError ||
    error instanceof StackAdapterError ||
    error instanceof StackCloudError
  ) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else throw error;
}
