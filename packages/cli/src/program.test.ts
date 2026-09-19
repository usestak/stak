import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import type {
  EnvironmentDiff,
  EnvironmentStatus,
  ScanResult,
} from '@stack/spec';

import { createProgram, type ProgramDependencies } from './program.js';

const emptyResult: ScanResult = {
  roots: [
    {
      path: '/home/test/.agents/skills',
      rootKind: 'agents',
      scope: 'global',
      status: 'scanned',
      skillLocations: 0,
    },
    {
      path: '/home/test/.cursor/skills',
      rootKind: 'cursor',
      scope: 'global',
      status: 'missing',
      skillLocations: 0,
    },
  ],
  skills: [],
  nameCollisions: [],
  diagnostics: [],
  summary: {
    roots: { scanned: 1, missing: 1, failed: 0 },
    uniqueSkillContents: 0,
    locations: 0,
    validSkills: 0,
    invalidSkills: 0,
    exactDuplicateContents: 0,
    nameCollisions: 0,
    diagnostics: { errors: 0, warnings: 0, info: 0 },
    provenance: { git: 0, local: 0, unknown: 0 },
  },
};

const emptyStatus: EnvironmentStatus = {
  schemaVersion: 1,
  environment: 'main',
  observedAt: '2026-09-19T12:00:00.000Z',
  desiredCount: 0,
  skills: [],
  untracked: [],
  placementDrift: [],
  invalidSkills: [],
  rootFailures: [],
  summary: {
    satisfied: 0,
    modified: 0,
    missing: 0,
    uncertain: 0,
    untracked: 0,
    placementAdded: 0,
    placementRemoved: 0,
    placementChanged: 0,
    invalid: 0,
    rootFailures: 0,
  },
};
const emptyDiff: EnvironmentDiff = { ...emptyStatus, entries: [] };

const runProgram = async (
  arguments_: string[],
  overrides: Partial<ProgramDependencies> = {},
) => {
  let output = '';
  const program = createProgram({
    scan: async () => emptyResult,
    initialize: async () => ({
      environment: 'main',
      importedSkills: 0,
      excludedInvalid: 0,
      excludedProject: 0,
      physicalLocations: 0,
      consolidatedDuplicates: 0,
      nameCollisions: 0,
      localOrUnknown: 0,
      files: {
        manifest: 'environment.yaml',
        lock: 'stack.lock.json',
        baseline: 'main.json',
        machine: 'machine.json',
      },
    }),
    status: async () => emptyStatus,
    diff: async () => emptyDiff,
    writeOut: (value) => {
      output += value;
    },
    ...overrides,
  });
  const capture = { writeOut: (value: string) => (output += value) };
  program.configureOutput(capture);
  program.exitOverride();
  for (const command of program.commands) {
    command.configureOutput(capture);
    command.exitOverride();
  }

  let exit: CommanderError | undefined;
  try {
    await program.parseAsync(['node', 'stack', ...arguments_]);
  } catch (error) {
    if (error instanceof CommanderError) exit = error;
    else throw error;
  }
  return { exit, output };
};

describe('Stack CLI', () => {
  it('prints root help with Phase 2 commands but without later commands', async () => {
    const result = await runProgram(['--help']);

    expect(result.exit?.exitCode).toBe(0);
    for (const command of ['scan', 'init', 'status', 'diff'])
      expect(result.output).toContain(`  ${command}`);
    for (const command of [
      'use',
      'remove',
      'try',
      'run',
      'restore',
      'push',
      'pull',
      'publish',
    ]) {
      expect(result.output).not.toContain(`  ${command}`);
    }
  });

  it.each(['init', 'status', 'diff'])(
    'documents the %s command',
    async (command) => {
      const result = await runProgram([command, '--help']);
      expect(result.exit?.exitCode).toBe(0);
      if (command !== 'init') expect(result.output).toContain('--json');
    },
  );

  it('documents JSON and project scan options', async () => {
    const result = await runProgram(['scan', '--help']);

    expect(result.output).toContain('--json');
    expect(result.output).toContain('--project');
  });

  it('emits parseable JSON and no decorative output', async () => {
    const result = await runProgram(['scan', '--json']);

    expect(JSON.parse(result.output)).toEqual(emptyResult);
    expect(result.output.trimStart().startsWith('{')).toBe(true);
  });

  it('forwards project scanning to the scanner', async () => {
    let includeProject = false;
    await runProgram(['scan', '--project'], {
      scan: async (options) => {
        includeProject = options.project;
        return emptyResult;
      },
    });

    expect(includeProject).toBe(true);
  });

  it('renders physical roots and the read-only assurance for humans', async () => {
    const result = await runProgram(['scan']);

    expect(result.output).toContain('Shared');
    expect(result.output).toContain('Cursor');
    expect(result.output).toContain('not found');
    expect(result.output).toContain('No changes were made.');
  });

  it('initializes from a fresh global scan', async () => {
    let project = true;
    let received: ScanResult | undefined;
    const result = await runProgram(['init'], {
      scan: async (options) => {
        project = options.project;
        return emptyResult;
      },
      initialize: async (scanResult) => {
        received = scanResult;
        return {
          environment: 'main',
          importedSkills: 0,
          excludedInvalid: 0,
          excludedProject: 0,
          physicalLocations: 0,
          consolidatedDuplicates: 0,
          nameCollisions: 0,
          localOrUnknown: 0,
          files: { manifest: '', lock: '', baseline: '', machine: '' },
        };
      },
    });
    expect(project).toBe(false);
    expect(received).toBe(emptyResult);
    expect(result.output).toContain('main created.');
  });

  it.each([
    ['status', emptyStatus],
    ['diff', emptyDiff],
  ] as const)('emits parseable %s JSON only', async (command, expected) => {
    const result = await runProgram([command, '--json']);
    expect(JSON.parse(result.output)).toEqual(expected);
    expect(result.output.trimStart().startsWith('{')).toBe(true);
  });

  it('renders concise human status and diff with read-only assurance', async () => {
    const status = await runProgram(['status']);
    const diff = await runProgram(['diff']);
    expect(status.output).toContain('Environment: main');
    expect(status.output).toContain('No changes were made.');
    expect(diff.output).toContain('Environment diff: main');
    expect(diff.output).toContain('No changes were made.');
  });

  it('prints the package version', async () => {
    const result = await runProgram(['--version']);

    expect(result.exit?.exitCode).toBe(0);
    expect(result.output).toBe('0.0.0\n');
  });
});
