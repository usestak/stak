import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CLI_REFERENCE_COMMANDS } from './cli-reference.data';

const here = path.dirname(fileURLToPath(import.meta.url));
const programSource = readFileSync(
  path.join(here, '../../../../../packages/cli/src/program.ts'),
  'utf8',
);

/**
 * program.ts's `createProgram` registers every top-level command by calling
 * `register<Name>Command(program, dependencies)` (see e.g. `registerScanCommand`,
 * `registerUseCommand`, `registerMemoryCommand`). The individual `.command('scan')` /
 * `.command('memory')` literals live inside each `packages/cli/src/commands/*.ts` file,
 * not in program.ts itself, and some of those files additionally register *nested*
 * subcommands (e.g. `memory scan`, `project map`, `skill pause`) that are not separate
 * top-level entries in CLI_REFERENCE_COMMANDS. Scanning program.ts for a literal
 * `.command('name')` string would therefore find nothing, while scanning every commands/*.ts
 * file for every `.command(...)` call would find more names than this page documents.
 * Extracting the `register<Name>Command(program` call sites from program.ts itself is the
 * one pattern that mirrors the actual top-level command set 1:1.
 */
function registeredCommandNames(source: string): string[] {
  const matches = source.matchAll(/register([A-Za-z]+)Command\(program/g);
  return [...new Set([...matches].map((m) => m[1].toLowerCase()))];
}

describe('CLI reference matches registered commands', () => {
  it('documents every command registered in program.ts', () => {
    const registered = registeredCommandNames(programSource);
    const documented = CLI_REFERENCE_COMMANDS.map((c) => c.name);
    for (const name of registered) {
      expect(documented).toContain(name);
    }
  });

  it('has no documented command that is not actually registered', () => {
    const registered = registeredCommandNames(programSource);
    for (const c of CLI_REFERENCE_COMMANDS) {
      expect(registered).toContain(c.name);
    }
  });
});
