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
import type { PullPlan, PushPlan, TrialStackResolution } from '@stack/core';
import type { DiscoveredMemoryItem } from '@stack/memory';

const memItem = (
  index: number,
  scope: 'global' | 'project',
  projectCanonical?: string,
): DiscoveredMemoryItem => ({
  provider: 'claude',
  kind: scope === 'project' ? 'auto-memory' : 'agent-memory',
  scope,
  logicalId: `claude/${scope}/${index}`,
  ...(projectCanonical
    ? {
        project: {
          kind: 'git' as const,
          host: 'github.com',
          owner: 'me',
          repo: projectCanonical,
          canonical: `github.com/me/${projectCanonical}`,
        },
      }
    : {}),
  contentHash: `sha256:${'a'.repeat(64)}`,
  restoreTarget: { base: 'claude-home', relativePath: `f${index}.md` },
  source: { path: `/machine/local/f${index}.md` },
  capturedAt: '2026-09-23T12:00:00.000Z',
  sensitivity: 'private',
});

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
    cloudLogin: async () => {
      throw new Error('not configured');
    },
    cloudLogout: async () => {
      throw new Error('not configured');
    },
    cloudWhoami: async () => {
      throw new Error('not configured');
    },
    cloudPreparePush: async () => {
      throw new Error('not configured');
    },
    cloudApplyPush: async () => {
      throw new Error('not configured');
    },
    cloudPreparePull: async () => {
      throw new Error('not configured');
    },
    cloudApplyPull: async () => {
      throw new Error('not configured');
    },
    cloudPreparePublish: async () => {
      throw new Error('not configured');
    },
    cloudApplyPublish: async () => {
      throw new Error('not configured');
    },
    memoryScan: async () => [],
    memoryBackup: async () => ({
      provider: 'claude',
      files: 0,
      projects: 0,
      createdAt: '2026-09-23T12:00:00.000Z',
    }),
    memoryStatus: async () => null,
    memoryRestore: async () => ({
      provider: 'claude',
      files: 0,
      projects: 0,
      items: [],
    }),
    memoryCloudBackup: async () => ({
      local: {
        provider: 'claude',
        files: 0,
        projects: 0,
        createdAt: '2026-09-25T12:00:00.000Z',
      },
      cloud: { status: 'skipped' },
    }),
    memoryCloudRecover: async () => ({ status: 'no-backup' }),
    memoryCloudProtect: async () => ({ status: 'not-authenticated' }),
    memoryProtectPasskey: async () => ({ status: 'not-authenticated' }),
    memoryRecoverPasskey: async () => ({ status: 'not-authenticated' }),
    memoryGenerations: async () => ({ status: 'not-authenticated' }),
    memoryCloudStatus: async () => ({
      authenticated: false,
      privacyMode: null,
      latestGeneration: null,
      lastCloudBackupAt: null,
      recoveryMethodTypes: [],
      deviceEnrolled: false,
      localRecoveredGeneration: null,
      historicalRecovery: false,
    }),
    projectList: async () => [],
    projectMap: async () => ({ status: 'project-not-found' }),
    memoryBackupPreview: async () => ({
      provider: 'claude',
      native: [],
      carriedForward: [],
      nativeFiles: 0,
      nativeProjects: 0,
      retainedFiles: 0,
      retainedProjects: 0,
      finalFiles: 0,
      finalProjects: 0,
      privacy: null,
      supersession: {
        localRecoveredGeneration: null,
        cloudLatestGeneration: null,
        parentGeneration: null,
        nextGeneration: null,
        supersedes: false,
      },
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
  it('prints root help with cloud commands but without deferred commands', async () => {
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
      'login',
      'logout',
      'whoami',
      'push',
      'pull',
      'publish',
    ])
      expect(result.output).toContain(`  ${command}`);
    for (const command of ['switch', 'restore']) {
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
    expect(result.output).toContain('Trying trial with Codex...');
    expect(result.output).toContain('temporary workspace');
    expect(result.output).toContain('Your main Stack will not be changed.');
    expect(result.output).toContain('Trial finished.');
    expect(result.output).toContain('Temporary files cleaned up.');
    // Internal isolation jargon stays out of default output.
    expect(result.output).not.toContain('disposable scratch workspace');
  });

  it('shows detailed trial isolation under --verbose', async () => {
    const result = await runProgram([
      'try',
      './trial',
      '--verbose',
      '--',
      'codex',
    ]);
    expect(result.output).toContain('disposable scratch workspace');
    expect(result.output).toContain('Temporary Environment cleaned');
  });

  it('reports incomplete cleanup with a safe, secret-free diagnostic', async () => {
    const result = await runProgram(['try', './trial', '--', 'codex'], {
      launchTry: async () => ({
        sessionId: 'try_12345678',
        exitCode: 0,
        signal: null,
        cleaned: false,
        cleanup: {
          component: 'workspace',
          code: 'EPERM',
          at: '2026-09-20T00:00:00.000Z',
        },
        retainedRuntimePath: 'C:\\Users\\x\\.stack\\runtime\\try_12345678',
      }),
    });
    expect(result.output).toContain('temporary cleanup was incomplete');
    expect(result.output).toContain('workspace');
    expect(result.output).toContain('EPERM');
    expect(result.output).toContain('try_12345678');
    expect(result.output).toContain('main was not changed');
    expect(result.output).not.toContain('auth');
    expect(result.output).not.toContain('token');
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

  it.each(['cursor', 'claude'] as const)(
    'supports %s dry-run JSON through the shared adapter surface',
    async (agent) => {
      const result = await runProgram(['run', agent, '--dry-run', '--json'], {
        detectAgent: async (requested) => ({
          agent: requested,
          installed: true,
          executablePath: `/bin/${requested}`,
        }),
        planAgentBindings: async (requested) => ({
          ...plan,
          agent: requested,
        }),
      });
      expect(JSON.parse(result.output)).toMatchObject({
        detection: { agent },
        plan: { agent },
        dryRun: true,
      });
    },
  );

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
    expect(result.output).toContain('Setting up Codex...');
    expect(result.output).toContain('1 skill added.');
    expect(result.output).toContain('Codex is ready.');
    expect(result.output).toContain('Launching Codex');
    expect(result.output).not.toContain('Binding root');
  });

  it('renders a beginner-friendly run dry-run', async () => {
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
    const result = await runProgram(['run', 'codex', '--dry-run'], {
      planCodexBindings: async () => addPlan,
    });
    expect(result.output).toContain('Codex will be set up with 1 skill.');
    expect(result.output).toContain('No changes were made.');
    expect(result.output).not.toContain('Binding root');
  });

  it('reports an already-set-up agent without jargon', async () => {
    const result = await runProgram(['run', 'codex'], {
      planCodexBindings: async () => plan,
    });
    expect(result.output).toContain('Codex is already set up with 0 skills.');
    expect(result.output).toContain('Launching Codex');
  });

  it('exposes the detailed binding plan under --verbose', async () => {
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
    const result = await runProgram(
      ['run', 'codex', '--dry-run', '--verbose'],
      {
        planCodexBindings: async () => addPlan,
      },
    );
    expect(result.output).toContain('Add      1');
    expect(result.output).toContain('Binding root');
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
    expect(result.output).toContain('Initialized Stack.');
    expect(result.output).toContain('No skills found yet.');
    expect(result.output).not.toContain('Preservation');
  });

  it('reports a beginner-friendly init summary', async () => {
    const result = await runProgram(['init'], {
      initialize: async () => ({
        environment: 'main',
        importedSkills: 31,
        excludedInvalid: 0,
        excludedProject: 0,
        physicalLocations: 31,
        consolidatedDuplicates: 0,
        nameCollisions: 0,
        localOrUnknown: 0,
        preservedContents: 31,
        reusedContents: 0,
        references: 0,
        snapshots: 31,
        integrityChecks: 31,
        files: { manifest: '', lock: '', baseline: '', machine: '' },
      }),
    });
    expect(result.output).toContain('Initialized Stack.');
    expect(result.output).toContain('Found 31 skills.');
    expect(result.output).toContain('Saved them to main.');
    expect(result.output).not.toContain('integrity checks');
  });

  it('shows detailed init diagnostics under --verbose', async () => {
    const result = await runProgram(['init', '--verbose'], {
      initialize: async () => ({
        environment: 'main',
        importedSkills: 31,
        excludedInvalid: 0,
        excludedProject: 0,
        physicalLocations: 31,
        consolidatedDuplicates: 0,
        nameCollisions: 0,
        localOrUnknown: 0,
        preservedContents: 31,
        reusedContents: 0,
        references: 0,
        snapshots: 31,
        integrityChecks: 31,
        files: { manifest: '', lock: '', baseline: '', machine: '' },
      }),
    });
    expect(result.output).toContain('Preservation');
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

  it('renders beginner-friendly status and diff without internal jargon', async () => {
    const status = await runProgram(['status']);
    const diff = await runProgram(['diff']);
    expect(status.output).toContain('Stack: main');
    expect(status.output).toContain('0 skills ready');
    expect(status.output).not.toContain('Local preservation');
    expect(status.output).not.toContain('Restoration strategy');
    expect(status.output).not.toContain('placement');
    expect(diff.output).toContain('No changes.');
    expect(diff.output).not.toContain('Environment diff: main');
    expect(diff.output).not.toContain('drift');
  });

  it('exposes internal state under --verbose for status and diff', async () => {
    const status = await runProgram(['status', '--verbose']);
    const diff = await runProgram(['diff', '--verbose']);
    expect(status.output).toContain('Environment: main');
    expect(status.output).toContain('Local preservation');
    expect(status.output).toContain('Restoration strategy');
    expect(diff.output).toContain('Environment diff: main');
  });

  it('shows agent readiness in status when detection is available', async () => {
    const result = await runProgram(['status'], {
      detectAgents: async () => [
        { agent: 'codex', ready: true },
        { agent: 'claude', ready: false },
      ],
    });
    expect(result.output).toContain('Codex');
    expect(result.output).toContain('ready');
    expect(result.output).toContain('not set up');
  });

  it('summarizes missing skills and points to diff', async () => {
    const result = await runProgram(['status'], {
      status: async () => ({
        ...emptyStatus,
        summary: { ...emptyStatus.summary, satisfied: 29, missing: 2 },
      }),
    });
    expect(result.output).toContain('29 skills ready');
    expect(result.output).toContain('2 skills missing');
    expect(result.output).toContain('Run `stack diff` to see what changed.');
  });

  it('prints the package version', async () => {
    const result = await runProgram(['--version']);

    expect(result.exit?.exitCode).toBe(0);
    expect(result.output).toBe('0.1.0\n');
  });

  const cloudBundle = {
    schemaVersion: 1 as const,
    environment: {
      schemaVersion: 1 as const,
      name: 'main',
      skills: [],
      stacks: [],
      overrides: {},
    },
    resolved: { schemaVersion: 1 as const, skills: {} },
    importedStackVersions: [],
    snapshotRequirements: [],
    digest: `sha256:${'a'.repeat(64)}`,
  };
  const basePushPlan: PushPlan = {
    environment: 'main',
    machineId: '00000000-0000-4000-8000-000000000000',
    bundle: cloudBundle,
    digest: cloudBundle.digest,
    remoteExists: false,
    remoteVersionNumber: null,
    remoteDigest: null,
    expectedLatestVersionId: null,
    noop: false,
    conflict: null,
    desiredSkills: 2,
    stackLayers: 1,
    references: 0,
    snapshotsAlready: 0,
    snapshotsToUpload: [`sha256:${'b'.repeat(64)}`],
    pendingUploads: [],
  };
  const basePullPlan: PullPlan = {
    environment: 'main',
    mode: 'create',
    conflict: null,
    remoteExists: true,
    remoteVersionNumber: 1,
    remoteDigest: cloudBundle.digest,
    localExists: false,
    localDigest: null,
    localSyncedVersionId: null,
    restore: {
      desiredSkills: 2,
      importedStackVersions: 1,
      alreadyPresent: [],
      snapshotDownloads: [`sha256:${'b'.repeat(64)}`],
      referenceRestores: [],
    },
    bundle: cloudBundle,
    remoteEnvironmentId: '00000000-0000-4000-8000-0000000000e0',
    remoteVersionId: '00000000-0000-4000-8000-000000000001',
  };

  it('emits secret-free push dry-run JSON', async () => {
    const result = await runProgram(['push', '--dry-run', '--json'], {
      cloudPreparePush: async () => basePushPlan,
    });
    const parsed = JSON.parse(result.output);
    expect(parsed).toMatchObject({
      environment: 'main',
      dryRun: true,
      snapshots: { alreadyUploaded: 0, needUpload: 1 },
    });
    expect(result.output).not.toContain('token');
    expect(result.output).not.toContain('pendingUploads');
  });

  it('never applies a push when a synchronization conflict exists, even with --yes', async () => {
    let applied = false;
    await expect(
      runProgram(['push', '--yes'], {
        cloudPreparePush: async () => ({
          ...basePushPlan,
          conflict: {
            kind: 'remote-newer',
            message: 'Cloud main changed since this Machine last synced.',
            localBaseVersionId: 'x',
            remoteVersionNumber: 4,
          },
        }),
        cloudApplyPush: async () => {
          applied = true;
          throw new Error('should not apply');
        },
      }),
    ).rejects.toThrow(/changed since this Machine last synced/);
    expect(applied).toBe(false);
  });

  it('previews a pull without changing agent setup', async () => {
    const result = await runProgram(['pull', '--dry-run'], {
      cloudPreparePull: async () => basePullPlan,
    });
    expect(result.output).toContain('Pull preview');
    expect(result.output).toContain('2 skills will be downloaded.');
    expect(result.output).toContain('Your agent setup will not be changed.');
    expect(result.output).not.toContain('Environment digest');
  });

  it('previews a pull with cloud internals under --verbose', async () => {
    const result = await runProgram(['pull', '--dry-run', '--verbose'], {
      cloudPreparePull: async () => basePullPlan,
    });
    expect(result.output).toContain('Cloud main');
    expect(result.output).toContain('Agent bindings will not be changed.');
    expect(result.output).toContain('Environment digest');
  });

  it('previews and applies a push in beginner-friendly language', async () => {
    const preview = await runProgram(['push', '--dry-run'], {
      cloudPreparePush: async () => basePushPlan,
    });
    expect(preview.output).toContain('Push preview');
    expect(preview.output).toContain('2 skills will be uploaded.');
    expect(preview.output).toContain('main will be created in the cloud.');
    expect(preview.output).not.toContain('Environment digest');

    const applied = await runProgram(['push', '--yes'], {
      cloudPreparePush: async () => basePushPlan,
      cloudApplyPush: async () => ({
        environment: 'main',
        versionId: '00000000-0000-4000-8000-000000000001',
        versionNumber: 1,
        digest: basePushPlan.digest,
        createdNew: true,
        uploaded: 2,
      }),
    });
    expect(applied.output).toContain('Pushing main...');
    expect(applied.output).toContain('2 skills uploaded.');
    expect(applied.output).toContain('main created in the cloud.');
  });

  it('applies a pull with a beginner-friendly summary and next step', async () => {
    const result = await runProgram(['pull', '--yes'], {
      cloudPreparePull: async () => basePullPlan,
      cloudApplyPull: async () => ({
        status: 'restored',
        environment: 'main',
        desiredSkills: 31,
        importedStackVersions: 1,
        snapshotsDownloaded: 31,
        referencesRestored: 0,
        reusedFromStore: 0,
        localSnapshotRecords: 31,
        digest: basePullPlan.remoteDigest ?? `sha256:${'a'.repeat(64)}`,
      }),
    });
    expect(result.output).toContain('Pulling main...');
    expect(result.output).toContain('31 skills downloaded.');
    expect(result.output).toContain('main is ready.');
    expect(result.output).toContain('Run `stack run codex` to set up Codex.');
  });

  it('emits parseable pull dry-run JSON', async () => {
    const result = await runProgram(['pull', '--dry-run', '--json'], {
      cloudPreparePull: async () => basePullPlan,
    });
    expect(JSON.parse(result.output)).toMatchObject({
      environment: 'main',
      dryRun: true,
      mode: 'create',
      snapshotDownloads: [`sha256:${'b'.repeat(64)}`],
    });
  });

  it('shows whoami without leaking credentials', async () => {
    const result = await runProgram(['whoami', '--json'], {
      cloudWhoami: async () => ({
        userId: '00000000-0000-4000-8000-00000000aaaa',
        githubUsername: 'temi',
        source: 'server',
      }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed).toMatchObject({ githubUsername: 'temi' });
    expect(result.output).not.toContain('token');
  });

  it('renders a concise whoami with name and handle', async () => {
    const result = await runProgram(['whoami'], {
      cloudWhoami: async () => ({
        userId: '00000000-0000-4000-8000-00000000aaaa',
        githubUsername: 'stephentony100',
        displayName: 'Temiloluwa',
        source: 'server',
      }),
    });
    expect(result.output).toBe('Temiloluwa\n@stephentony100\n');
  });

  it('reports logout outcomes', async () => {
    const revoked = await runProgram(['logout'], {
      cloudLogout: async () => ({ wasSignedIn: true, remoteRevoked: true }),
    });
    expect(revoked.output).toContain('Signed out.');
    const offline = await runProgram(['logout'], {
      cloudLogout: async () => ({ wasSignedIn: true, remoteRevoked: false }),
    });
    expect(offline.output).toContain('Signed out locally.');
  });

  it('documents the memory subcommands', async () => {
    const result = await runProgram(['memory', '--help']);
    for (const sub of [
      'scan',
      'backup',
      'protect',
      'recover',
      'status',
      'restore',
    ])
      expect(result.output).toContain(sub);
  });

  const scanItems = [
    memItem(0, 'project', 'alpha'),
    memItem(1, 'project', 'beta'),
    memItem(2, 'project', 'gamma'),
    ...Array.from({ length: 9 }, (_, index) => memItem(index + 3, 'global')),
  ];

  it('renders a beginner-friendly memory scan without internal detail', async () => {
    const result = await runProgram(['memory', 'scan'], {
      memoryScan: async () => scanItems,
    });
    expect(result.output).toContain('Claude');
    expect(result.output).toContain('3 projects with memory');
    expect(result.output).toContain('12 memory files found');
    expect(result.output).toContain('Nothing was changed.');
    // No hashes or absolute native paths in default output.
    expect(result.output).not.toContain('sha256:');
    expect(result.output).not.toContain('/machine/local/');
  });

  it('emits memory scan JSON without absolute native paths', async () => {
    const result = await runProgram(['memory', 'scan', '--json'], {
      memoryScan: async () => scanItems,
    });
    const parsed = JSON.parse(result.output);
    expect(parsed).toMatchObject({ provider: 'claude', files: 12 });
    // Portable JSON must not carry machine-local source paths.
    expect(result.output).not.toContain('/machine/local/');
  });

  it('reports an empty memory scan simply', async () => {
    const result = await runProgram(['memory', 'scan'], {
      memoryScan: async () => [],
    });
    expect(result.output).toContain('No memory found.');
  });

  it('backs up locally and to Cloud (Standard) with calm output', async () => {
    const result = await runProgram(['memory', 'backup'], {
      memoryCloudBackup: async () => ({
        local: {
          provider: 'claude',
          files: 12,
          projects: 3,
          createdAt: '2026-09-25T12:00:00.000Z',
        },
        cloud: { status: 'standard', generation: 0 },
      }),
    });
    expect(result.output).toContain('Backing up Claude memory...');
    expect(result.output).toContain('12 memory files saved locally.');
    expect(result.output).toContain('3 projects backed up to Stack Cloud.');
    expect(result.output).toContain('Privacy: Standard');
  });

  it('backs up locally and calmly skips Cloud when signed out', async () => {
    const result = await runProgram(['memory', 'backup']); // default stub: skipped
    expect(result.output).toContain('saved locally.');
    expect(result.output).toContain('Cloud backup skipped.');
    expect(result.output).toContain('stack login');
  });

  it('fails the Cloud backup closed for a Protected account with no local key', async () => {
    const result = await runProgram(['memory', 'backup'], {
      memoryCloudBackup: async () => ({
        local: {
          provider: 'claude',
          files: 5,
          projects: 2,
          createdAt: '2026-09-25T12:00:00.000Z',
        },
        cloud: { status: 'protected-locked' },
      }),
    });
    expect(result.output).toContain('saved locally.');
    expect(result.output).toContain('cannot unlock your protected Memory');
    expect(result.output).not.toContain('Privacy: Standard');
  });

  it('shows memory status with Cloud state', async () => {
    const signedOut = await runProgram(['memory', 'status']); // default stub
    expect(signedOut.output).toContain('not signed in');
    const present = await runProgram(['memory', 'status'], {
      memoryStatus: async () => ({
        provider: 'claude',
        projects: 3,
        files: 12,
        lastBackupAt: '2026-09-25T12:00:00.000Z',
      }),
      memoryCloudStatus: async () => ({
        authenticated: true,
        privacyMode: 'protected',
        latestGeneration: 4,
        lastCloudBackupAt: '2026-09-25T12:00:00.000Z',
        recoveryMethodTypes: ['passkey'],
        deviceEnrolled: true,
        localRecoveredGeneration: 4,
        historicalRecovery: false,
      }),
    });
    expect(present.output).toContain('3 projects backed up');
    expect(present.output).toContain('Privacy');
    expect(present.output).toContain('Protected');
    expect(present.output).toContain('Recovery');
  });

  it('protect reports not-signed-in without a session', async () => {
    const result = await runProgram(['memory', 'protect']); // default: not-authenticated
    expect(result.output).toContain('Not signed in.');
  });

  it('protect --passkey shows the Passkey method and no recovery-file copy', async () => {
    const result = await runProgram(['memory', 'protect', '--passkey'], {
      memoryProtectPasskey: async () => ({ status: 'protected', migrated: 1 }),
    });
    expect(result.output).toContain('Protected backup enabled.');
    expect(result.output).toContain('Passkey    Ready');
    expect(result.output).toContain('1 file migrated to Protected.');
    // The recovery-file wording must NOT appear for the passkey path.
    expect(result.output).not.toContain('Recovery file');
    expect(result.output).not.toContain('Keep this file safe');
  });

  it('protect (recovery file) still shows the recovery-file method and warning', async () => {
    const result = await runProgram(['memory', 'protect'], {
      memoryCloudProtect: async () => ({
        migrated: 1,
        recoveryFilePath: '/tmp/stack-memory-recovery.stackkey',
      }),
    });
    expect(result.output).toContain('Recovery file    Ready');
    expect(result.output).toContain('Keep this file safe');
    expect(result.output).not.toContain('Passkey    Ready');
  });

  it('protect --passkey JSON reports recoveryMethod passkey (no file warning)', async () => {
    const result = await runProgram(
      ['memory', 'protect', '--passkey', '--json'],
      {
        memoryProtectPasskey: async () => ({
          status: 'protected',
          migrated: 2,
        }),
      },
    );
    const parsed = JSON.parse(result.output) as { recoveryMethod?: string };
    expect(parsed.recoveryMethod).toBe('passkey');
    expect(result.output).not.toContain('Keep this file safe');
  });

  it('protect (recovery file) JSON reports recoveryMethod recovery-file', async () => {
    const result = await runProgram(['memory', 'protect', '--json'], {
      memoryCloudProtect: async () => ({
        migrated: 0,
        recoveryFilePath: '/tmp/stack-memory-recovery.stackkey',
      }),
    });
    const parsed = JSON.parse(result.output) as {
      recoveryMethod?: string;
      recoveryFilePath?: string;
    };
    expect(parsed.recoveryMethod).toBe('recovery-file');
    expect(parsed.recoveryFilePath).toBe('/tmp/stack-memory-recovery.stackkey');
  });

  it('recover reports no Cloud backup for an empty account', async () => {
    const result = await runProgram(['memory', 'recover']); // default: no-backup
    expect(result.output).toContain('No Cloud backup found');
  });

  it('previews a memory restore without changing agent memory', async () => {
    const result = await runProgram(['memory', 'restore', '--dry-run'], {
      memoryRestore: async ({ apply }) => {
        expect(apply).toBe(false);
        return {
          provider: 'claude',
          files: 12,
          projects: 3,
          items: scanItems.map((item) => ({
            logicalId: item.logicalId,
            kind: item.kind,
            scope: item.scope,
            status: 'restorable' as const,
          })),
        };
      },
    });
    expect(result.output).toContain('Memory restore preview');
    expect(result.output).toContain(
      'Existing agent memory will not be overwritten.',
    );
    expect(result.output).toContain('No changes were made.');
  });

  it('emits restore JSON with the summary project count, not one-per-file', async () => {
    const result = await runProgram(
      ['memory', 'restore', '--dry-run', '--json'],
      {
        memoryRestore: async () => ({
          provider: 'claude',
          files: 24,
          projects: 9,
          items: Array.from({ length: 24 }, (_, index) => ({
            logicalId: `claude/auto-memory/p/f${index}.md`,
            kind: 'auto-memory' as const,
            scope: 'project' as const,
            status: 'project-not-found' as const,
          })),
        }),
      },
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.projects).toBe(9);
    expect(parsed.files).toBe(24);
    expect(parsed.items).toHaveLength(24);
  });

  it('memory backup --dry-run previews the 9 + 18 → 27 composition without mutating', async () => {
    const preview = {
      provider: 'claude' as const,
      native: [],
      carriedForward: [],
      nativeFiles: 9,
      nativeProjects: 2,
      retainedFiles: 18,
      retainedProjects: 7,
      finalFiles: 27,
      finalProjects: 9,
      privacy: 'protected' as const,
      supersession: {
        localRecoveredGeneration: null,
        cloudLatestGeneration: null,
        parentGeneration: null,
        nextGeneration: null,
        supersedes: false,
      },
    };
    const result = await runProgram(['memory', 'backup', '--dry-run'], {
      memoryBackupPreview: async () => preview,
      // If a real backup were attempted this would throw, proving no mutation.
      memoryCloudBackup: async () => {
        throw new Error('dry-run must not run a real backup');
      },
    });
    expect(result.output).toContain('Memory backup preview');
    expect(result.output).toContain('27 memory files');
    expect(result.output).toContain('18 memory files carried forward');
    expect(result.output).toContain('No changes were made.');
    expect(result.output).toContain('Privacy: Protected');
  });

  it('memory backup --dry-run --json emits deterministic composition counts', async () => {
    const result = await runProgram(
      ['memory', 'backup', '--dry-run', '--json'],
      {
        memoryBackupPreview: async () => ({
          provider: 'claude',
          native: [],
          carriedForward: [],
          nativeFiles: 9,
          nativeProjects: 2,
          retainedFiles: 18,
          retainedProjects: 7,
          finalFiles: 27,
          finalProjects: 9,
          privacy: 'protected',
          supersession: {
            localRecoveredGeneration: null,
            cloudLatestGeneration: null,
            parentGeneration: null,
            nextGeneration: null,
            supersedes: false,
          },
        }),
      },
    );
    const parsed = JSON.parse(result.output);
    expect(parsed).toMatchObject({
      nativeFiles: 9,
      retainedFiles: 18,
      finalFiles: 27,
      finalProjects: 9,
      privacy: 'protected',
      dryRun: true,
    });
  });

  it('memory generations lists recoverable generations newest-first', async () => {
    const result = await runProgram(['memory', 'generations'], {
      memoryGenerations: async () => ({
        status: 'ok',
        generations: [
          {
            generation: 4,
            createdAt: '2026-09-28T16:45:57.000Z',
            privacyMode: 'protected',
            state: 'committed',
            payloadBytes: 76442,
            latest: true,
          },
          {
            generation: 3,
            createdAt: '2026-09-26T13:58:45.000Z',
            privacyMode: 'protected',
            state: 'committed',
            payloadBytes: 73126,
            latest: false,
          },
        ],
      }),
    });
    expect(result.output).toContain('Memory generations');
    expect(result.output).toContain('4');
    expect(result.output).toContain('latest');
    expect(result.output).toContain('--generation');
  });

  it('memory generations --json emits the generation metadata', async () => {
    const result = await runProgram(['memory', 'generations', '--json'], {
      memoryGenerations: async () => ({
        status: 'ok',
        generations: [
          {
            generation: 4,
            createdAt: '2026-09-28T16:45:57.000Z',
            privacyMode: 'protected',
            state: 'committed',
            payloadBytes: 76442,
            latest: true,
          },
        ],
      }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.generations[0]).toMatchObject({
      generation: 4,
      latest: true,
    });
  });

  it('memory status shows a historical-recovery relationship, not “up to date”', async () => {
    const result = await runProgram(['memory', 'status'], {
      memoryStatus: async () => ({
        provider: 'claude',
        projects: 9,
        files: 27,
        lastBackupAt: '2026-09-26T12:00:00.000Z',
      }),
      memoryCloudStatus: async () => ({
        authenticated: true,
        privacyMode: 'protected',
        latestGeneration: 4,
        lastCloudBackupAt: '2026-09-28T12:00:00.000Z',
        recoveryMethodTypes: ['passkey'],
        deviceEnrolled: true,
        localRecoveredGeneration: 3,
        historicalRecovery: true,
      }),
    });
    expect(result.output).toContain('Local source      Generation 3');
    expect(result.output).toContain('Cloud latest      Generation 4');
    expect(result.output).toContain('Historical recovery');
    expect(result.output).not.toContain('up to date');
  });

  it('memory backup from historical local state requires confirmation before superseding', async () => {
    const supersedingPreview = {
      provider: 'claude' as const,
      native: [],
      carriedForward: [],
      nativeFiles: 9,
      nativeProjects: 2,
      retainedFiles: 18,
      retainedProjects: 7,
      finalFiles: 27,
      finalProjects: 9,
      privacy: 'protected' as const,
      supersession: {
        localRecoveredGeneration: 3,
        cloudLatestGeneration: 4,
        parentGeneration: 4,
        nextGeneration: 5,
        supersedes: true,
      },
    };
    // Declined → cancelled, no backup performed.
    const declined = await runProgram(['memory', 'backup'], {
      memoryBackupPreview: async () => supersedingPreview,
      confirm: async () => false,
      memoryCloudBackup: async () => {
        throw new Error('must not back up without confirmation');
      },
    });
    expect(declined.output).toContain('supersede generation 4');
    expect(declined.output).toContain('Cancelled.');

    // Confirmed → proceeds.
    let backedUp = false;
    await runProgram(['memory', 'backup'], {
      memoryBackupPreview: async () => supersedingPreview,
      confirm: async () => true,
      memoryCloudBackup: async () => {
        backedUp = true;
        return {
          local: {
            provider: 'claude',
            files: 27,
            projects: 9,
            createdAt: '2026-09-29T00:00:00.000Z',
          },
          cloud: { status: 'protected', generation: 5 },
        };
      },
    });
    expect(backedUp).toBe(true);
  });
});
