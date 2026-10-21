import type {
  AgentId,
  TryExitResult,
  TryPreparationResult,
  TryResolvedEnvironment,
} from '@stack/spec';

import { agentLabel, block, skills } from './format.js';

export type RenderOptions = { verbose?: boolean };

// Per-agent label for the isolated config/state directory line in dry-run and
// verbose output (e.g. "Temporary CODEX_HOME" vs "Temporary Claude
// state/config" vs "Temporary Cursor state/config").
const agentHomeLabel = (agent: AgentId): string =>
  agent === 'codex' ? 'CODEX_HOME' : `${agentLabel(agent)} state/config`;

export const renderTryDryRun = (
  trial: TryResolvedEnvironment,
  agent: AgentId,
) =>
  `STAK: ${trial.stackName}\nAgent: ${agentLabel(agent)}\n\nResolved Skills       ${trial.environment.skills.length}\nRequired              ${trial.required}\nOptional included     ${trial.optionalIncluded}\nOptional skipped      ${trial.skippedOptional}\nRenamed (conflict)    ${trial.environment.renamed.length}\nConflicts             ${trial.environment.conflicts.length}\n\nIsolation\n\nTemporary HOME        yes\nTemporary ${agentHomeLabel(agent)}  yes\nWorkspace Skills      ${trial.environment.skills.length}\n\nmain will not be changed.\nNormal ${agentLabel(agent)} bindings will not be changed.\n\nNo runtime was created.\n`;

const renderTryReadyVerbose = (
  preparation: TryPreparationResult,
  agent: AgentId,
) =>
  `Trying STAK: ${preparation.session.source.displayName}\n\n${preparation.session.resolvedSkills.length} Skills resolved\n${preparation.session.resolvedSkills.length} Skills materialized into isolated workspace\n\nIsolation\n+ main unchanged\n+ normal ${agentLabel(agent)} bindings untouched\n+ temporary user home\n+ temporary ${agentHomeLabel(agent)}\n\nThis trial uses a disposable scratch workspace.\nFiles created here will be removed when the session ends.\n\nLaunching ${agentLabel(agent)}...\n\nNote: ${agentLabel(agent)} built-in/system Skills may still be available.\n`;

export const renderTryReady = (
  preparation: TryPreparationResult,
  agent: AgentId,
  options: RenderOptions = {},
): string => {
  if (options.verbose) return renderTryReadyVerbose(preparation, agent);
  const session = preparation.session;
  return block([
    `Trying ${session.source.displayName} with ${agentLabel(agent)}...`,
    '',
    `${skills(session.resolvedSkills.length)} loaded in a temporary workspace.`,
    'Your main STAK will not be changed.',
    '',
    `Launching ${agentLabel(agent)}...`,
  ]);
};

export const renderTryExit = (
  result: TryExitResult,
  agent: AgentId,
  options: RenderOptions = {},
): string => {
  const exit = result.exitCode ?? 'signal';
  if (result.cleaned) {
    if (options.verbose)
      return `Trial ended.\n\n${agentLabel(agent)} exit code: ${exit}\nTemporary Environment cleaned.\n\nmain\n+ unchanged\n\nNormal ${agentLabel(agent)} bindings\n+ unchanged\n`;
    return block(['Trial finished.', 'Temporary files cleaned up.']);
  }
  const component = result.cleanup?.component ?? 'workspace';
  const code = result.cleanup?.code ?? 'unknown';
  const retained = result.retainedRuntimePath ?? '(under STACK_HOME)';
  return block([
    'Trial finished, but temporary cleanup was incomplete.',
    '',
    `Component:`,
    component,
    '',
    `Error:`,
    code,
    '',
    'Runtime retained safely:',
    retained,
    '',
    'STAK will retry cleanup on a future trial.',
    '',
    'main was not changed.',
    `Normal ${agentLabel(agent)} bindings were not changed.`,
  ]);
};
