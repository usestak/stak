import type {
  TryExitResult,
  TryPreparationResult,
  TryResolvedEnvironment,
} from '@stack/spec';

import { block, skills } from './format.js';

export type RenderOptions = { verbose?: boolean };

export const renderTryDryRun = (trial: TryResolvedEnvironment) =>
  `STAK: ${trial.stackName}\nAgent: Codex\n\nResolved Skills       ${trial.environment.skills.length}\nRequired              ${trial.required}\nOptional included     ${trial.optionalIncluded}\nOptional skipped      ${trial.skippedOptional}\nConflicts             ${trial.environment.conflicts.length}\n\nIsolation\n\nTemporary HOME        yes\nTemporary CODEX_HOME  yes\nWorkspace Skills      ${trial.environment.skills.length}\n\nmain will not be changed.\nNormal Codex bindings will not be changed.\n\nNo runtime was created.\n`;

const renderTryReadyVerbose = (preparation: TryPreparationResult) =>
  `Trying STAK: ${preparation.session.source.displayName}\n\n${preparation.session.resolvedSkills.length} Skills resolved\n${preparation.session.resolvedSkills.length} Skills materialized into isolated workspace\n\nIsolation\n+ main unchanged\n+ normal Codex bindings untouched\n+ temporary user home\n+ temporary Codex home\n\nThis trial uses a disposable scratch workspace.\nFiles created here will be removed when the session ends.\n\nLaunching Codex...\n\nNote: Codex built-in/system Skills may still be available.\n`;

export const renderTryReady = (
  preparation: TryPreparationResult,
  options: RenderOptions = {},
): string => {
  if (options.verbose) return renderTryReadyVerbose(preparation);
  const session = preparation.session;
  return block([
    `Trying ${session.source.displayName} with Codex...`,
    '',
    `${skills(session.resolvedSkills.length)} loaded in a temporary workspace.`,
    'Your main STAK will not be changed.',
    '',
    'Launching Codex...',
  ]);
};

export const renderTryExit = (
  result: TryExitResult,
  options: RenderOptions = {},
): string => {
  const exit = result.exitCode ?? 'signal';
  if (result.cleaned) {
    if (options.verbose)
      return `Trial ended.\n\nCodex exit code: ${exit}\nTemporary Environment cleaned.\n\nmain\n+ unchanged\n\nNormal Codex bindings\n+ unchanged\n`;
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
    'Normal Codex bindings were not changed.',
  ]);
};
