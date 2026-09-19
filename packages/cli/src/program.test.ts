import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import type {
  AgentDetection,
  BindingApplyResult,
  BindingPlan,
  BindingVerification,
  EnvironmentDiff,
  EnvironmentStatus,
  LaunchResult,
  ResolvedLocalEnvironment,
  ScanResult,
} from '@stack/spec';

import { createProgram, type ProgramDependencies } from './program.js';
import type { TrialStackResolution } from '@stack/core';

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
    preservation: { available: 0, missing: 0, corrupt: 0 },
    restoration: { reference: 0, snapshot: 0 },
  },
};
const emptyDiff: EnvironmentDiff = { ...emptyStatus, entries: [] };
const resolvedEnvironment: ResolvedLocalEnvironment = {
  name: 'main',
  machineId: '00000000-0000-4000-8000-000000000000',
  skills: [],
};
const detection: AgentDetection = {
  agent: 'codex',
  installed: true,
  executablePath: '/bin/codex',
};
const plan: BindingPlan = {
  schemaVersion: 1,
  agent: 'codex',
  environment: 'main',
  targetRoot: '/home/test/.agents/skills',
  operations: [],
  blocking: false,
};
const applyResult: BindingApplyResult = {
  agent: 'codex',
  applied: [],
  removed: [],
  unchanged: 0,
  rolledBack: false,
};
const verification: BindingVerification = {
  agent: 'codex',
  healthy: true,
  bindings: [],
};
const launchResult: LaunchResult = {
  agent: 'codex',
  exitCode: 0,
  signal: null,
};
const trialResolution = {
  loaded: {
    version: {
      schemaVersion: 1,
      name: 'trial',
      description: 'trial',
      versionHash: `sha256:${'a'.repeat(64)}`,
      requirements: [],
      inheritedStacks: [],
      skippedOptional: [],
    },
    sources: new Map(),
  },
  resolved: {
    stackName: 'trial',
    stackVersionHash: `sha256:${'a'.repeat(64)}`,
    environment: { name: 'try:trial', skills: [], skipped: [], conflicts: [] },
    skippedOptional: 0,
    required: 0,
    optionalIncluded: 0,
    isolation: {
      temporaryHome: true,
      temporaryCodexHome: true,
      scratchWorkspace: true,
      normalBindingsUntouched: true,
      mainUntouched: true,
    },
  },
} satisfies TrialStackResolution;
const tryPreparation = {
  session: {
    schemaVersion: 1 as const,
    sessionId: 'try_12345678',
    agent: 'codex' as const,
    createdAt: '2026-09-19T12:00:00.000Z',
    ownerPid: 1,
    source: { type: 'local-stack' as const, displayName: 'trial' },
    runtimeRootPath: '/runtime',
    workspacePath: '/runtime/workspace',
    runtimeHomePath: '/runtime/home',
    runtimeCodexHomePath: '/runtime/codex-home',
    resolvedSkills: [],
    status: 'ready' as const,
  },
  bridgedFiles: [],
};

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
      preservedContents: 0,
      reusedContents: 0,
      references: 0,
      snapshots: 0,
      integrityChecks: 0,
      files: {
        manifest: 'environment.yaml',
        lock: 'stack.lock.json',
        baseline: 'main.json',
        machine: 'machine.json',
      },
    }),
    status: async () => emptyStatus,
    diff: async () => emptyDiff,
    prepareUse: async () => {
      throw new Error('not configured');
    },
    applyUse: async () => undefined,
    prepareRemove: async () => {
      throw new Error('not configured');
    },
    applyRemove: async () => undefined,
    loadRunEnvironment: async () => resolvedEnvironment,
    detectCodex: async () => detection,
    planCodexBindings: async () => plan,
    applyCodexBindings: async () => applyResult,
    verifyCodexBindings: async () => verification,
    launchCodex: async () => launchResult,
    resolveTry: async () => trialResolution,
    preserveTry: async () => undefined,
    prepareTry: async () => tryPreparation,
    cleanupTry: async () => undefined,
    launchTry: async () => ({
      sessionId: 'try_12345678',
      exitCode: 0,
      signal: null,
      cleaned: true,
    }),
    confirm: async () => true,
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
  it('prints root help with try but without Phase 7+ commands', async () => {
    const result = await runProgram(['--help']);

    expect(result.exit?.exitCode).toBe(0);
    for (const command of [
      'scan',
      'init',
      'status',
      'diff',
      'use',
      'remove',
      'run',
      'try',
    ])
      expect(result.output).toContain(`  ${command}`);
    for (const command of ['switch', 'restore', 'push', 'pull', 'publish']) {
      expect(result.output).not.toContain(`  ${command}`);
    }
  });

  it('supports canonical try dry-run syntax with parseable secret-free JSON', async () => {
    const result = await runProgram([
      'try',
      './trial',
      '--dry-run',
      '--json',
      '--',
      'codex',
    ]);
    const parsed = JSON.parse(result.output);
    expect(parsed).toMatchObject({
      dryRun: true,
      resolution: { stackName: 'trial' },
      mutation: {
        store: false,
        runtime: false,
        main: false,
        normalBindings: false,
      },
    });
    expect(result.output).not.toContain('auth');
  });

  it('preserves, prepares, launches, and reports cleanup for a normal try', async () => {
    const calls: string[] = [];
    const result = await runProgram(['try', './trial', '--', 'codex'], {
      preserveTry: async () => {
        calls.push('preserve');
      },
      prepareTry: async () => {
        calls.push('prepare');
        return tryPreparation;
      },
      launchTry: async () => {
        calls.push('launch');
        return {
          sessionId: 'try_12345678',
          exitCode: 0,
          signal: null,
          cleaned: true,
        };
      },
      cleanupTry: async () => {
        calls.push('cleanup');
      },
    });
    expect(calls).toEqual(['preserve', 'prepare', 'launch', 'cleanup']);
    expect(result.output).toContain('disposable scratch workspace');
    expect(result.output).toContain('Temporary Environment cleaned');
  });

  it('cleans a prepared trial when rendering fails before launch', async () => {
    let cleanupCalled = false;
    await expect(
      runProgram(['try', './trial', '--', 'codex'], {
        writeOut: () => {
          throw new Error('output failed');
        },
        cleanupTry: async () => {
          cleanupCalled = true;
        },
      }),
    ).rejects.toThrow('output failed');
    expect(cleanupCalled).toBe(true);
  });

  it('documents Codex-only run options', async () => {
    const result = await runProgram(['run', '--help']);
    expect(result.output).toContain('<agent>');
    expect(result.output).toContain('Codex');
    const codex = await runProgram(['run', 'codex', '--help']);
    expect(codex.output).toContain('--dry-run');
    expect(codex.output).toContain('--yes');
    expect(codex.output).toContain('--json');
  });

  it('dry-run plans without applying or launching and emits parseable JSON', async () => {
    let applied = false;
    let launched = false;
    const result = await runProgram(['run', 'codex', '--dry-run', '--json'], {
      applyCodexBindings: async () => {
        applied = true;
        return applyResult;
      },
      launchCodex: async () => {
        launched = true;
        return launchResult;
      },
    });
    expect(JSON.parse(result.output)).toMatchObject({
      detection,
      plan,
      dryRun: true,
    });
    expect(applied).toBe(false);
    expect(launched).toBe(false);
  });

  it('detects missing Codex before planning or mutation', async () => {
    let planned = false;
    await expect(
      runProgram(['run', 'codex'], {
        detectCodex: async () => ({ agent: 'codex', installed: false }),
        planCodexBindings: async () => {
          planned = true;
          return plan;
        },
      }),
    ).rejects.toThrow('Codex CLI was not found');
    expect(planned).toBe(false);
  });

  it('fails cleanly when main does not exist', async () => {
    await expect(
      runProgram(['run', 'codex'], {
        loadRunEnvironment: async () => {
          throw new Error(
            'main does not exist. Run stack scan and stack init.',
          );
        },
      }),
    ).rejects.toThrow('main does not exist');
  });

  it('requires approval for mutations and does not launch when declined', async () => {
    let launched = false;
    const addPlan: BindingPlan = {
      ...plan,
      operations: [
        {
          state: 'add',
          entryId: 'skill_12345678',
          skillName: 'demo',
          contentHash: `sha256:${'a'.repeat(64)}`,
          targetPath: '/home/test/.agents/skills/demo',
        },
      ],
    };
    const result = await runProgram(['run', 'codex'], {
      planCodexBindings: async () => addPlan,
      confirm: async () => false,
      launchCodex: async () => {
        launched = true;
        return launchResult;
      },
    });
    expect(result.output).toContain('Cancelled');
    expect(launched).toBe(false);
  });

  it('blocks conflicts even with --yes', async () => {
    let applied = false;
    const conflictPlan: BindingPlan = {
      ...plan,
      blocking: true,
      operations: [
        {
          state: 'conflict-unmanaged',
          entryId: 'skill_12345678',
          skillName: 'demo',
          contentHash: `sha256:${'a'.repeat(64)}`,
          currentHash: `sha256:${'b'.repeat(64)}`,
          targetPath: '/home/test/.agents/skills/demo',
        },
      ],
    };
    await expect(
      runProgram(['run', 'codex', '--yes'], {
        planCodexBindings: async () => conflictPlan,
        applyCodexBindings: async () => {
          applied = true;
          return applyResult;
        },
      }),
    ).rejects.toThrow('unresolved conflicts');
    expect(applied).toBe(false);
  });

  it('launches without confirmation when no binding mutations are needed', async () => {
    let confirmed = false;
    let launched = false;
    const result = await runProgram(['run', 'codex'], {
      confirm: async () => {
        confirmed = true;
        return true;
      },
      launchCodex: async () => {
        launched = true;
        return launchResult;
      },
    });
    expect(confirmed).toBe(false);
    expect(launched).toBe(true);
    expect(result.output).toContain('Launching Codex');
  });

  it('applies, verifies, and launches approved additions', async () => {
    const calls: string[] = [];
    const addPlan: BindingPlan = {
      ...plan,
      operations: [
        {
          state: 'add',
          entryId: 'skill_12345678',
          skillName: 'demo',
          contentHash: `sha256:${'a'.repeat(64)}`,
          targetPath: '/home/test/.agents/skills/demo',
        },
      ],
    };
    const result = await runProgram(['run', 'codex', '--yes'], {
      planCodexBindings: async () => addPlan,
      applyCodexBindings: async () => {
        calls.push('apply');
        return applyResult;
      },
      verifyCodexBindings: async () => {
        calls.push('verify');
        return verification;
      },
      launchCodex: async () => {
        calls.push('launch');
        return launchResult;
      },
    });
    expect(calls).toEqual(['apply', 'verify', 'launch']);
    expect(result.output).toContain('Bindings applied and verified');
  });

  it('renders dry-run additions and conflicts for humans', async () => {
    const addPlan: BindingPlan = {
      ...plan,
      operations: [
        {
          state: 'add',
          entryId: 'skill_12345678',
          skillName: 'demo',
          contentHash: `sha256:${'a'.repeat(64)}`,
          targetPath: '/home/test/.agents/skills/demo',
        },
      ],
    };
    expect(
      (
        await runProgram(['run', 'codex', '--dry-run'], {
          planCodexBindings: async () => addPlan,
        })
      ).output,
    ).toContain('Add      1');
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
          preservedContents: 0,
          reusedContents: 0,
          references: 0,
          snapshots: 0,
          integrityChecks: 0,
          files: { manifest: '', lock: '', baseline: '', machine: '' },
        };
      },
    });
    expect(project).toBe(false);
    expect(received).toBe(emptyResult);
    expect(result.output).toContain('main created.');
    expect(result.output).toContain('Preservation');
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
    expect(status.output).toContain('Local preservation');
    expect(status.output).toContain('Restoration strategy');
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
