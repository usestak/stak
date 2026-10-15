import { CommanderError } from 'commander';
import { describe, expect, it, vi } from 'vitest';

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
import type { MachineCheckinRequest } from '@stack/spec';
import {
  CloudUnavailableError,
  NotAuthenticatedError,
  type CloudClient,
} from '@stack/cloud-client';

import {
  createProgram,
  isOwnedUseProposal,
  isRemoteUseProposal,
  type ProgramDependencies,
} from './program.js';
import { gatherCheckinInputs, reportCheckin } from './cloud/checkin.js';
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
    projectArchive: async () => ({ status: 'project-not-found' }),
    projectUnarchive: async () => ({ status: 'project-not-found' }),
    skillUpdate: async () => ({ status: 'ok', agents: [] }),
    skillPause: async () => ({ status: 'not-found' }),
    skillResume: async () => ({ status: 'not-found' }),
    skillCheck: async () => ({ checked: [] }),
    machineId: async () => '00000000-0000-4000-8000-000000000001',
    openUrl: (machineId) =>
      `http://localhost:3000/overview?machine=${encodeURIComponent(machineId)}`,
    openBrowser: async () => undefined,
    memoryBackupPreview: async () => ({
      provider: 'claude',
      native: [],
      carriedForward: [],
      nativeFiles: 0,
      nativeProjects: 0,
      availableProjects: 0,
      retainedFiles: 0,
      retainedProjects: 0,
      retainedAvailableFiles: 0,
      retainedAvailableProjects: 0,
      retainedUnavailableFiles: 0,
      retainedUnavailableProjects: 0,
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

// Release-gate finding (2026-10-15): the shared Cloud-error message tells users to
// retry with `--verbose`, but six Cloud-touching commands never registered that
// option, so Commander's own strict parser rejected it with "unknown option"
// before the real (actionable) error was ever reached. These prove Commander now
// accepts `--verbose` on each — reaching the mocked dependency's own rejection
// (rather than a CommanderError for an unknown option) IS the proof the flag parsed.
describe('--verbose is accepted by every Cloud command the error message recommends it for', () => {
  it('stak login --verbose parses (reaches cloudLogin, not an unknown-option error)', async () => {
    await expect(runProgram(['login', '--verbose'])).rejects.toThrow(
      'not configured',
    );
  });

  it('stak logout --verbose parses', async () => {
    await expect(runProgram(['logout', '--verbose'])).rejects.toThrow(
      'not configured',
    );
  });

  it('stak publish <stak> --verbose parses', async () => {
    await expect(
      runProgram(['publish', 'some-stak', '--verbose']),
    ).rejects.toThrow('not configured');
  });

  it('stak remove <stak> --verbose parses', async () => {
    await expect(
      runProgram(['remove', 'some-stak', '--verbose']),
    ).rejects.toThrow('not configured');
  });

  it('stak use <stak> --verbose parses', async () => {
    await expect(runProgram(['use', 'some-stak', '--verbose'])).rejects.toThrow(
      'not configured',
    );
  });

  it('stak whoami --verbose parses', async () => {
    await expect(runProgram(['whoami', '--verbose'])).rejects.toThrow(
      'not configured',
    );
  });
});

describe('applyUse proposal discrimination (P10B)', () => {
  // These exercise the exact shapes prepareStackUse/prepareRemoteStackUse/prepareOwnedStackUse
  // produce. Regression: the discriminator once checked `'kind' in proposal.source`, which is
  // false for BOTH remote and owned sources (neither carries a `kind` field — `kind` only
  // lives one level down, on the persisted manifest layer), so every owned-Stack `stak use`
  // silently misrouted through the remote-Stack apply path.
  const local = { loaded: {} } as unknown;
  const remote = { source: { owner: 'alice', slug: 'frontend' } } as unknown;
  const owned = { source: { stackId: 'stack_1', name: 'frontend' } } as unknown;

  it('identifies a local Stack proposal as neither owned nor remote', () => {
    expect(isOwnedUseProposal(local as never)).toBe(false);
    expect(isRemoteUseProposal(local as never)).toBe(false);
  });

  it('identifies a remote (public @owner/slug) Stack proposal', () => {
    expect(isRemoteUseProposal(remote as never)).toBe(true);
    expect(isOwnedUseProposal(remote as never)).toBe(false);
  });

  it('identifies an owned (private named) Stack proposal', () => {
    expect(isOwnedUseProposal(owned as never)).toBe(true);
    expect(isRemoteUseProposal(owned as never)).toBe(false);
  });
});

describe('`stak use` renders the right proposal kind (P10B)', () => {
  const ownedProposal = {
    source: {
      stackId: 'stack_1',
      name: 'frontend',
      versionHash: `sha256:${'a'.repeat(64)}`,
      version: { requirements: [] },
    },
    layer: { id: 'layer_1', stackId: 'stack_1', name: 'frontend' },
    resolved: { skills: [], skipped: [], conflicts: [] },
    summary: {
      alreadySatisfied: 0,
      newSkills: 0,
      optionalSkipped: 0,
      hardConflicts: 0,
      stackLayers: 1,
      resolvedSkills: 0,
      references: 0,
    },
  } as unknown as Awaited<ReturnType<ProgramDependencies['prepareUse']>>;

  it('renders an owned (private named) Stack proposal via the owned path, not the remote path', async () => {
    const result = await runProgram(['use', 'frontend', '--dry-run'], {
      prepareUse: async () => ownedProposal,
    });
    expect(result.output).toContain('your Cloud STAK: frontend');
    expect(result.output).not.toContain('public STAK');
  });
});

describe('STAK CLI', () => {
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

  it('presents the STAK brand: the executable is `stak` (R2)', async () => {
    expect(createProgram().name()).toBe('stak');
    const help = await runProgram(['--help']);
    expect(help.output).toContain('Usage: stak');
    // The reusable domain object's user-visible name is "STAK": the `use` command
    // takes a `<stak>` argument (`stak use <stak>`).
    expect(help.output).toMatch(/use .*<stak>/);
    const version = await runProgram(['--version']);
    expect(version.output.trim()).toBe('0.1.0');
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
    expect(result.output).toContain('Your main STAK will not be changed.');
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
          throw new Error('main does not exist. Run stak scan and stak init.');
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

  // P1 review (scan trigger): `scan` is read-only for projection but refreshes the machine's
  // reported inventory (agentsDetected), which the 0.1.0 onboarding contract (P8) consumes.
  // A successful scan must therefore publish the machine's detected agents via check-in.
  describe('scan reports machine state via check-in', () => {
    const clientWith = (
      machineCheckin: (r: MachineCheckinRequest) => Promise<unknown>,
    ): Pick<CloudClient, 'machineCheckin'> => ({
      machineCheckin: machineCheckin as CloudClient['machineCheckin'],
    });
    // A faithful reporter: the real gather + report pipeline, so the offline/auth policy is
    // exercised exactly as in production (offline swallowed, 401/403 re-thrown).
    const scanReporter =
      (client: Pick<CloudClient, 'machineCheckin'>, agents: string[]) =>
      async () => {
        const inputs = await gatherCheckinInputs({
          machine: async () => ({
            machineId: '00000000-0000-4000-8000-0000000000c3',
            platform: 'linux',
            arch: 'x64',
          }),
          hostname: () => 'test-host',
          memoryBackedUp: async () => false,
          installedSkills: async () => [],
          projectPresence: async () => [],
          agentsDetected: async () => agents,
        });
        await reportCheckin({ client, inputs });
      };

    it('a successful scan invokes check-in carrying the detected agents (#1, #2)', async () => {
      const captured: MachineCheckinRequest[] = [];
      const reportMachineCheckin = vi.fn(
        scanReporter(
          clientWith(async (r) => {
            captured.push(r);
            return { ok: true };
          }),
          ['claude', 'codex', 'cursor'],
        ),
      );
      const result = await runProgram(['scan'], { reportMachineCheckin });

      expect(result.exit?.exitCode ?? 0).toBe(0);
      expect(reportMachineCheckin).toHaveBeenCalledOnce();
      expect(reportMachineCheckin).toHaveBeenCalledWith('scan');
      expect(captured).toHaveLength(1);
      expect(captured[0]?.agentsDetected).toEqual([
        'claude',
        'codex',
        'cursor',
      ]);
    });

    it('scan still does not alter agent projection (#3)', async () => {
      let scanned = false;
      const applyUse = vi.fn(async () => undefined);
      const applyRemove = vi.fn(async () => undefined);
      const applyCodexBindings = vi.fn(async () => applyResult);
      const reportMachineCheckin = vi.fn(
        scanReporter(
          clientWith(async () => ({ ok: true })),
          ['claude'],
        ),
      );
      await runProgram(['scan'], {
        scan: async () => {
          scanned = true;
          return emptyResult;
        },
        applyUse,
        applyRemove,
        applyCodexBindings,
        reportMachineCheckin,
      });

      expect(scanned).toBe(true); // read-only discovery ran
      expect(applyUse).not.toHaveBeenCalled();
      expect(applyRemove).not.toHaveBeenCalled();
      expect(applyCodexBindings).not.toHaveBeenCalled();
    });

    it('an offline/failed check-in does not make scan fail (#4)', async () => {
      const reportMachineCheckin = vi.fn(
        scanReporter(
          clientWith(async () => {
            throw new CloudUnavailableError('offline');
          }),
          ['claude'],
        ),
      );
      const result = await runProgram(['scan'], { reportMachineCheckin });

      expect(result.exit?.exitCode ?? 0).toBe(0);
      expect(result.output).toContain('No changes were made.');
      expect(reportMachineCheckin).toHaveBeenCalledOnce();
    });

    it('a 401/403 during check-in stays explicit, not swallowed as offline (#5)', async () => {
      const reportMachineCheckin = vi.fn(
        scanReporter(
          clientWith(async () => {
            throw new NotAuthenticatedError('revoked');
          }),
          ['claude'],
        ),
      );

      await expect(
        runProgram(['scan'], { reportMachineCheckin }),
      ).rejects.toBeInstanceOf(NotAuthenticatedError);
    });
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
    expect(result.output).toContain('Initialized STAK.');
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
    expect(result.output).toContain('Initialized STAK.');
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
    expect(status.output).toContain('STAK: main');
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
    expect(result.output).toContain('Run `stak diff` to see what changed.');
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
    expect(result.output).toContain('Run `stak run codex` to set up Codex.');
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
    expect(result.output).toContain('3 projects backed up to STAK Cloud.');
    expect(result.output).toContain('Privacy: Standard');
  });

  it('backs up locally and calmly skips Cloud when signed out', async () => {
    const result = await runProgram(['memory', 'backup']); // default stub: skipped
    expect(result.output).toContain('saved locally.');
    expect(result.output).toContain('Cloud backup skipped.');
    expect(result.output).toContain('stak login');
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
      availableProjects: 2,
      retainedFiles: 18,
      retainedProjects: 7,
      retainedAvailableFiles: 0,
      retainedAvailableProjects: 0,
      retainedUnavailableFiles: 18,
      retainedUnavailableProjects: 7,
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
    expect(result.output).toContain('18 previous memory files preserved');
    expect(result.output).toContain('7 projects not available on this machine');
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
          availableProjects: 2,
          retainedFiles: 18,
          retainedProjects: 7,
          retainedAvailableFiles: 0,
          retainedAvailableProjects: 0,
          retainedUnavailableFiles: 18,
          retainedUnavailableProjects: 7,
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
      availableProjects: 2,
      nativeFiles: 9,
      retainedFiles: 18,
      retainedAvailableFiles: 0,
      retainedUnavailableFiles: 18,
      finalFiles: 27,
      finalProjects: 9,
      privacy: 'protected',
      dryRun: true,
    });
  });

  const twoGenerations = {
    status: 'ok' as const,
    generations: [
      {
        generation: 4,
        createdAt: '2026-09-28T16:45:57.000Z',
        privacyMode: 'protected' as const,
        state: 'committed',
        payloadBytes: 76442,
        latest: true,
      },
      {
        generation: 3,
        createdAt: '2026-09-26T13:58:45.000Z',
        privacyMode: 'protected' as const,
        state: 'committed',
        payloadBytes: 73126,
        latest: false,
      },
    ],
  };

  it('memory history lists backups in backup terminology (newest first)', async () => {
    const result = await runProgram(['memory', 'history'], {
      memoryGenerations: async () => twoGenerations,
    });
    expect(result.output).toContain('Memory backup history');
    expect(result.output).toContain('#4');
    expect(result.output).toContain('latest');
    expect(result.output).toContain('--backup');
    expect(result.output).not.toContain('generation');
  });

  it('memory generations still works as a hidden compatibility alias', async () => {
    const result = await runProgram(['memory', 'generations'], {
      memoryGenerations: async () => twoGenerations,
    });
    expect(result.output).toContain('Memory backup history');
    expect(result.output).toContain('#4');
  });

  it('normal help advertises history and hides the generations alias', async () => {
    const help = await runProgram(['memory', '--help']);
    expect(help.output).toContain('history');
    expect(help.output).not.toContain('generations');
  });

  it('memory history --json uses backup terminology only (no generation fields)', async () => {
    const result = await runProgram(['memory', 'history', '--json'], {
      memoryGenerations: async () => ({
        status: 'ok',
        generations: twoGenerations.generations.slice(0, 1),
      }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.backups[0]).toMatchObject({ backup: 4, latest: true });
    // Public JSON exposes no generation terminology.
    expect(parsed.generations).toBeUndefined();
    expect(parsed.backups[0].generation).toBeUndefined();
    expect(result.output).not.toContain('generation');
  });

  it('hidden `memory generations --json` returns the modern backup JSON', async () => {
    const result = await runProgram(['memory', 'generations', '--json'], {
      memoryGenerations: async () => ({
        status: 'ok',
        generations: twoGenerations.generations.slice(0, 1),
      }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.backups[0]).toMatchObject({ backup: 4 });
    expect(parsed.generations).toBeUndefined();
  });

  it('recover --json uses `backup`, not `generation`', async () => {
    const result = await runProgram(
      ['memory', 'recover', '--backup', '3', '--json'],
      {
        memoryCloudRecover: async () => ({
          status: 'recovered',
          privacyMode: 'protected',
          objects: 27,
          generation: 3,
        }),
      },
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.backup).toBe(3);
    expect(parsed.generation).toBeUndefined();
  });

  it('hidden recover --generation --json returns the modern backup JSON', async () => {
    const result = await runProgram(
      ['memory', 'recover', '--generation', '3', '--json'],
      {
        memoryCloudRecover: async () => ({
          status: 'recovered',
          privacyMode: 'protected',
          objects: 27,
          generation: 3,
        }),
      },
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.backup).toBe(3);
    expect(parsed.generation).toBeUndefined();
  });

  it('status --json exposes backup-named fields only', async () => {
    const result = await runProgram(['memory', 'status', '--json'], {
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
    const parsed = JSON.parse(result.output);
    expect(parsed.cloud.localRecoveredBackup).toBe(3);
    expect(parsed.cloud.cloudLatestBackup).toBe(4);
    expect(parsed.cloud.latestGeneration).toBeUndefined();
    expect(parsed.cloud.localRecoveredGeneration).toBeUndefined();
  });

  it('backup --dry-run --json exposes backup-named supersession fields only', async () => {
    const result = await runProgram(
      ['memory', 'backup', '--dry-run', '--json'],
      {
        memoryBackupPreview: async () => ({
          provider: 'claude',
          native: [],
          carriedForward: [],
          nativeFiles: 9,
          nativeProjects: 2,
          availableProjects: 2,
          retainedFiles: 18,
          retainedProjects: 7,
          retainedAvailableFiles: 0,
          retainedAvailableProjects: 0,
          retainedUnavailableFiles: 18,
          retainedUnavailableProjects: 7,
          finalFiles: 27,
          finalProjects: 9,
          privacy: 'protected',
          supersession: {
            localRecoveredGeneration: 3,
            cloudLatestGeneration: 4,
            parentGeneration: 4,
            nextGeneration: 5,
            supersedes: true,
          },
        }),
      },
    );
    const parsed = JSON.parse(result.output);
    expect(parsed).toMatchObject({
      nextBackup: 5,
      parentBackup: 4,
      localSourceBackup: 3,
      cloudLatestBackup: 4,
      supersedes: true,
    });
    expect(parsed.nextGeneration).toBeUndefined();
    expect(parsed.parentGeneration).toBeUndefined();
    expect(parsed.cloudLatestGeneration).toBeUndefined();
    expect(parsed.localRecoveredGeneration).toBeUndefined();
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
    expect(result.output).toContain('Local source      Backup #3');
    expect(result.output).toContain('Cloud latest      Backup #4');
    expect(result.output).toContain('Historical recovery');
    expect(result.output).not.toContain('up to date');
    expect(result.output).not.toContain('Generation');
  });

  it('memory backup from historical local state requires confirmation before superseding', async () => {
    const supersedingPreview = {
      provider: 'claude' as const,
      native: [],
      carriedForward: [],
      nativeFiles: 9,
      nativeProjects: 2,
      availableProjects: 2,
      retainedFiles: 18,
      retainedProjects: 7,
      retainedAvailableFiles: 0,
      retainedAvailableProjects: 0,
      retainedUnavailableFiles: 18,
      retainedUnavailableProjects: 7,
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
    expect(declined.output).toContain('backup #5');
    expect(declined.output).toContain('#4');
    expect(declined.output.toLowerCase()).not.toContain('generation');
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

  it('recover --backup N selects exactly N and reports it as backup #N', async () => {
    let requested: number | undefined;
    const result = await runProgram(['memory', 'recover', '--backup', '3'], {
      memoryCloudRecover: async (opts) => {
        requested = opts.generation;
        return {
          status: 'recovered',
          privacyMode: 'protected',
          objects: 27,
          generation: 3,
        };
      },
    });
    expect(requested).toBe(3);
    expect(result.output).toContain('backup #3');
  });

  it('recover --generation N still works as a compatibility alias', async () => {
    let requested: number | undefined;
    await runProgram(['memory', 'recover', '--generation', '3'], {
      memoryCloudRecover: async (opts) => {
        requested = opts.generation;
        return {
          status: 'recovered',
          privacyMode: 'protected',
          objects: 27,
          generation: 3,
        };
      },
    });
    expect(requested).toBe(3);
  });

  it('recover fails clearly when --backup and --generation disagree', async () => {
    let called = false;
    const result = await runProgram(
      ['memory', 'recover', '--backup', '3', '--generation', '4'],
      {
        memoryCloudRecover: async () => {
          called = true;
          return { status: 'no-backup' };
        },
      },
    );
    expect(called).toBe(false);
    expect(result.output).toContain('only one of --backup or --generation');
  });

  it('a nonexistent backup reports “Backup #N was not found.”', async () => {
    const result = await runProgram(['memory', 'recover', '--backup', '99'], {
      memoryCloudRecover: async () => ({ status: 'no-backup' }),
    });
    expect(result.output).toContain('Backup #99 was not found.');
  });

  const lifecycleRows = [
    {
      projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      identity: { kind: 'git' as const, canonical: 'github.com/acme/atlas' },
      lifecycle: 'active' as const,
      binding: null,
      files: 7,
      availability: 'present' as const,
      conflict: false,
      recoveryReference: null,
    },
    {
      projectId: 'prj_bbbbbbbbbbbbbbbbbbbbbbbbbb',
      identity: { kind: 'local' as const },
      lifecycle: 'archived' as const,
      binding: null,
      files: 4,
      availability: 'unavailable' as const,
      conflict: false,
      recoveryReference: null,
    },
  ];

  it('project list groups ACTIVE and ARCHIVED and shows lifecycle in JSON', async () => {
    const human = await runProgram(['project'], {
      projectList: async () => lifecycleRows,
    });
    expect(human.output).toContain('ACTIVE');
    expect(human.output).toContain('ARCHIVED');

    const json = await runProgram(['project', '--json'], {
      projectList: async () => lifecycleRows,
    });
    const parsed = JSON.parse(json.output);
    expect(parsed.projects[0].lifecycle).toBe('active');
    expect(parsed.projects[1].lifecycle).toBe('archived');
  });

  it('project archive confirms, then reports the change and the backup hint', async () => {
    let archived = false;
    const declined = await runProgram(['project', 'archive', 'prj_x'], {
      confirm: async () => false,
      projectArchive: async () => {
        archived = true;
        return {
          status: 'ok',
          projectId: 'prj_x',
          lifecycle: 'archived',
          changed: true,
        };
      },
    });
    expect(declined.output).toContain('Cancelled.');
    expect(archived).toBe(false);

    const ok = await runProgram(['project', 'archive', 'prj_x', '--yes'], {
      projectArchive: async () => ({
        status: 'ok',
        projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
        lifecycle: 'archived',
        changed: true,
        cloudPropagation: 'ok',
      }),
    });
    expect(ok.output).toContain('Archived');
  });

  it('project archive warns truthfully when Cloud propagation fails (offline)', async () => {
    const result = await runProgram(['project', 'archive', 'prj_x', '--yes'], {
      projectArchive: async () => ({
        status: 'ok',
        projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
        lifecycle: 'archived',
        changed: true,
        cloudPropagation: 'failed',
      }),
    });
    expect(result.output).toContain('Archived');
    expect(result.output.toLowerCase()).toContain('cloud was not updated');
    expect(result.output).toContain('again when connected');
  });

  it('project unarchive reactivates without a prompt', async () => {
    let confirmed = false;
    const result = await runProgram(['project', 'unarchive', 'prj_x'], {
      confirm: async () => {
        confirmed = true;
        return true;
      },
      projectUnarchive: async () => ({
        status: 'ok',
        projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaa',
        lifecycle: 'active',
        changed: true,
      }),
    });
    expect(confirmed).toBe(false); // unarchive is non-destructive; no prompt
    expect(result.output).toContain('is active');
  });
});

describe('stak skill lifecycle (P2)', () => {
  const clientWith = (
    machineCheckin: (r: MachineCheckinRequest) => Promise<unknown>,
  ): Pick<CloudClient, 'machineCheckin'> => ({
    machineCheckin: machineCheckin as CloudClient['machineCheckin'],
  });
  // A faithful reporter, so the offline/auth policy is exercised exactly as in production.
  const reporter =
    (client: Pick<CloudClient, 'machineCheckin'>) => async () => {
      const inputs = await gatherCheckinInputs({
        machine: async () => ({
          machineId: '00000000-0000-4000-8000-0000000000d4',
          platform: 'linux',
          arch: 'x64',
        }),
        hostname: () => 'test-host',
        memoryBackedUp: async () => false,
        installedSkills: async () => [],
        projectPresence: async () => [],
        agentsDetected: async () => [],
      });
      await reportCheckin({ client, inputs });
    };

  it('`skill update <skill>` targets one stable Skill', async () => {
    let received: { selector?: string } | undefined;
    const result = await runProgram(['skill', 'update', 'review-pr'], {
      skillUpdate: async (options) => {
        received = options;
        return {
          status: 'ok',
          selector: 'review-pr',
          entryId: 'skill_aaaaaaaa',
          agents: [{ agent: 'codex', applied: 1, removed: 0, unchanged: 2 }],
        };
      },
    });
    expect(received).toEqual({ selector: 'review-pr' });
    expect(result.output).toContain('review-pr');
    expect(result.output).toContain('codex');
  });

  it('`skill update` with no argument updates all machine Skills', async () => {
    let received: { selector?: string } | undefined = { selector: 'sentinel' };
    await runProgram(['skill', 'update'], {
      skillUpdate: async (options) => {
        received = options;
        return { status: 'ok', agents: [] };
      },
    });
    expect(received).toEqual({}); // no selector → all
  });

  it('an ambiguous selector fails safely with guidance, no mutation', async () => {
    const result = await runProgram(['skill', 'update', 'dup'], {
      skillUpdate: async () => ({
        status: 'ambiguous',
        matches: ['skill_dup00001', 'skill_dup00002'],
      }),
    });
    expect(result.exit?.exitCode ?? 0).toBe(0);
    expect(result.output.toLowerCase()).toContain('stable skill id');
  });

  it('`skill pause` and `skill resume` call the lifecycle ops', async () => {
    let paused: string | undefined;
    let resumed: string | undefined;
    await runProgram(['skill', 'pause', 'alpha'], {
      skillPause: async ({ selector }) => {
        paused = selector;
        return {
          status: 'ok',
          entryId: 'skill_aaaaaaaa',
          name: 'alpha',
          paused: true,
          changed: true,
        };
      },
    });
    await runProgram(['skill', 'resume', 'alpha'], {
      skillResume: async ({ selector }) => {
        resumed = selector;
        return {
          status: 'ok',
          entryId: 'skill_aaaaaaaa',
          name: 'alpha',
          paused: false,
          changed: true,
        };
      },
    });
    expect(paused).toBe('alpha');
    expect(resumed).toBe('alpha');
  });

  it('pause output tells the user the local effect is deferred until reconciliation', async () => {
    const result = await runProgram(['skill', 'pause', 'alpha'], {
      skillPause: async () => ({
        status: 'ok',
        entryId: 'skill_aaaaaaaa',
        name: 'alpha',
        paused: true,
        changed: true,
      }),
    });
    // Must not imply agents changed now; must point at reconciliation.
    expect(result.output).toContain('in STAK');
    expect(result.output).toContain('stak run');
    expect(result.output.toLowerCase()).toContain('unchanged');
  });

  it('a successful `skill update` reports installed state through check-in', async () => {
    const captured: MachineCheckinRequest[] = [];
    const reportMachineCheckin = vi.fn(
      reporter(
        clientWith(async (r) => {
          captured.push(r);
          return { ok: true };
        }),
      ),
    );
    const result = await runProgram(['skill', 'update'], {
      skillUpdate: async () => ({ status: 'ok', agents: [] }),
      reportMachineCheckin,
    });
    expect(result.exit?.exitCode ?? 0).toBe(0);
    expect(reportMachineCheckin).toHaveBeenCalledOnce();
    expect(reportMachineCheckin).toHaveBeenCalledWith('update');
    expect(captured).toHaveLength(1);
  });

  it('`skill pause`/`resume` change desired state only and do NOT check in', async () => {
    const reportMachineCheckin = vi.fn(async () => undefined);
    const ok = {
      status: 'ok' as const,
      entryId: 'skill_aaaaaaaa',
      name: 'alpha',
      paused: true,
      changed: true,
    };
    await runProgram(['skill', 'pause', 'alpha'], {
      skillPause: async () => ok,
      reportMachineCheckin,
    });
    await runProgram(['skill', 'resume', 'alpha'], {
      skillResume: async () => ({ ...ok, paused: false }),
      reportMachineCheckin,
    });
    expect(reportMachineCheckin).not.toHaveBeenCalled();
  });

  it('a failed `skill update` does not check in (update-failure path)', async () => {
    const reportMachineCheckin = vi.fn(async () => undefined);
    await expect(
      runProgram(['skill', 'update'], {
        skillUpdate: async () => {
          throw new Error('rolled back');
        },
        reportMachineCheckin,
      }),
    ).rejects.toThrow('rolled back');
    expect(reportMachineCheckin).not.toHaveBeenCalled();
  });

  it('an offline check-in after `skill update` is non-fatal', async () => {
    const reportMachineCheckin = vi.fn(
      reporter(
        clientWith(async () => {
          throw new CloudUnavailableError('offline');
        }),
      ),
    );
    const result = await runProgram(['skill', 'update'], {
      skillUpdate: async () => ({ status: 'ok', agents: [] }),
      reportMachineCheckin,
    });
    expect(result.exit?.exitCode ?? 0).toBe(0);
    expect(reportMachineCheckin).toHaveBeenCalledOnce();
  });

  it('a 401/403 after `skill update` stays explicit (not swallowed)', async () => {
    const reportMachineCheckin = vi.fn(
      reporter(
        clientWith(async () => {
          throw new NotAuthenticatedError('revoked');
        }),
      ),
    );
    await expect(
      runProgram(['skill', 'update'], {
        skillUpdate: async () => ({ status: 'ok', agents: [] }),
        reportMachineCheckin,
      }),
    ).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});

describe('stak open (P4)', () => {
  const MACHINE = '00000000-0000-4000-8000-0000000000a1';
  const openUrl = (machineId: string) =>
    `https://app.stak.test/overview?machine=${encodeURIComponent(machineId)}`;

  it('launches the browser at the machine-context URL (no secrets)', async () => {
    let opened = '';
    const result = await runProgram(['open'], {
      machineId: async () => MACHINE,
      openUrl,
      openBrowser: async (url) => {
        opened = url;
      },
    });
    expect(result.exit?.exitCode ?? 0).toBe(0);
    expect(opened).toBe(`https://app.stak.test/overview?machine=${MACHINE}`);
    expect(opened).not.toMatch(/token|secret|authorization|bearer/i);
    expect(result.output).toContain(MACHINE);
  });

  it('--print emits the URL and does NOT launch a browser', async () => {
    let launched = false;
    const result = await runProgram(['open', '--print'], {
      machineId: async () => MACHINE,
      openUrl,
      openBrowser: async () => {
        launched = true;
      },
    });
    expect(launched).toBe(false);
    expect(result.output.trim()).toBe(
      `https://app.stak.test/overview?machine=${MACHINE}`,
    );
  });

  it('fails clearly when the machine identity cannot be determined', async () => {
    await expect(
      runProgram(['open'], {
        machineId: async () => {
          throw new Error('Machine identity is corrupt or unreadable.');
        },
        openUrl,
        openBrowser: async () => undefined,
      }),
    ).rejects.toThrow(/machine identity/i);
  });

  it('surfaces a browser-launch failure', async () => {
    await expect(
      runProgram(['open'], {
        machineId: async () => MACHINE,
        openUrl,
        openBrowser: async () => {
          throw new Error('no browser');
        },
      }),
    ).rejects.toThrow('no browser');
  });

  it('does not check in (opening the browser mutates no machine state)', async () => {
    const reportMachineCheckin = vi.fn(async () => undefined);
    await runProgram(['open'], {
      machineId: async () => MACHINE,
      openUrl,
      openBrowser: async () => undefined,
      reportMachineCheckin,
    });
    expect(reportMachineCheckin).not.toHaveBeenCalled();
  });
});
