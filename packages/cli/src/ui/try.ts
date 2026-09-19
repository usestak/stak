import type {
  TryExitResult,
  TryPreparationResult,
  TryResolvedEnvironment,
} from '@stack/spec';

export const renderTryDryRun = (trial: TryResolvedEnvironment) =>
  `Stack: ${trial.stackName}\nAgent: Codex\n\nResolved Skills       ${trial.environment.skills.length}\nRequired              ${trial.required}\nOptional included     ${trial.optionalIncluded}\nOptional skipped      ${trial.skippedOptional}\nConflicts             ${trial.environment.conflicts.length}\n\nIsolation\n\nTemporary HOME        yes\nTemporary CODEX_HOME  yes\nWorkspace Skills      ${trial.environment.skills.length}\n\nmain will not be changed.\nNormal Codex bindings will not be changed.\n\nNo runtime was created.\n`;

export const renderTryReady = (preparation: TryPreparationResult) =>
  `Trying Stack: ${preparation.session.source.displayName}\n\n${preparation.session.resolvedSkills.length} Skills resolved\n${preparation.session.resolvedSkills.length} Skills materialized into isolated workspace\n\nIsolation\n+ main unchanged\n+ normal Codex bindings untouched\n+ temporary user home\n+ temporary Codex home\n\nThis trial uses a disposable scratch workspace.\nFiles created here will be removed when the session ends.\n\nLaunching Codex...\n\nNote: Codex built-in/system Skills may still be available.\n`;

export const renderTryExit = (result: TryExitResult) =>
  `Trial ended.\n\nCodex exit code: ${result.exitCode ?? 'signal'}\nTemporary Environment cleaned.\n\nmain\n+ unchanged\n\nNormal Codex bindings\n+ unchanged\n`;
