import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from './program.js';

const runProgram = async (argument: '--help' | '--version') => {
  let output = '';
  const program = createProgram();

  program.configureOutput({
    writeOut: (value) => {
      output += value;
    },
  });
  program.exitOverride();

  let exit: CommanderError | undefined;
  try {
    await program.parseAsync(['node', 'stack', argument]);
  } catch (error) {
    if (error instanceof CommanderError) {
      exit = error;
    } else {
      throw error;
    }
  }

  return { exit, output };
};

describe('Stack CLI', () => {
  it('prints help without registering Phase 1 commands', async () => {
    const result = await runProgram('--help');

    expect(result.exit?.exitCode).toBe(0);
    expect(result.output).toContain('Usage: stack [options]');
    expect(result.output).toContain('portable AI agent environments');
    expect(result.output).not.toContain('scan');
  });

  it('prints the package version', async () => {
    const result = await runProgram('--version');

    expect(result.exit?.exitCode).toBe(0);
    expect(result.output).toBe('0.0.0\n');
  });
});
