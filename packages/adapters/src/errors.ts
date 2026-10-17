export class StackAdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StackAdapterError';
  }
}
export class AgentNotInstalledError extends StackAdapterError {
  constructor(agent = 'Codex') {
    super('agent-not-installed', `${agent} CLI was not found on this machine.`);
    this.name = 'AgentNotInstalledError';
  }
}
export class BindingConflictError extends StackAdapterError {
  constructor(
    message = 'The Codex binding plan contains unresolved conflicts.',
  ) {
    super('binding-conflict', message);
    this.name = 'BindingConflictError';
  }
}
export class BindingApplyFailedError extends StackAdapterError {
  constructor(message: string, options?: ErrorOptions) {
    super('binding-apply-failed', message, options);
    this.name = 'BindingApplyFailedError';
  }
}
export class BindingRollbackFailedError extends StackAdapterError {
  constructor(message: string, options?: ErrorOptions) {
    super('binding-rollback-failed', message, options);
    this.name = 'BindingRollbackFailedError';
  }
}
export class BindingRegistryCorruptError extends StackAdapterError {
  constructor(message: string, options?: ErrorOptions) {
    super('binding-registry-corrupt', message, options);
    this.name = 'BindingRegistryCorruptError';
  }
}
export class AgentLaunchFailedError extends StackAdapterError {
  constructor(message: string, options?: ErrorOptions) {
    super('agent-launch-failed', message, options);
    this.name = 'AgentLaunchFailedError';
  }
}
export class TryRuntimePreparationFailedError extends StackAdapterError {
  constructor(
    message = 'The isolated Codex trial runtime could not be prepared.',
    options?: ErrorOptions,
  ) {
    super('try-runtime-preparation-failed', message, options);
    this.name = 'TryRuntimePreparationFailedError';
  }
}
export class TryRuntimeCleanupFailedError extends StackAdapterError {
  constructor(agent = 'Codex', options?: ErrorOptions) {
    super(
      'try-runtime-cleanup-failed',
      `The isolated ${agent} trial runtime could not be cleaned.`,
      options,
    );
    this.name = 'TryRuntimeCleanupFailedError';
  }
}
export class TryAuthBridgeFailedError extends StackAdapterError {
  constructor(agent = 'Codex', options?: ErrorOptions) {
    super(
      'try-auth-bridge-failed',
      `Allowlisted ${agent} runtime state could not be copied.`,
      options,
    );
    this.name = 'TryAuthBridgeFailedError';
  }
}
export class UnsafeRuntimePathError extends StackAdapterError {
  constructor() {
    super(
      'unsafe-runtime-path',
      'A trial Skill name is not a safe filesystem segment.',
    );
    this.name = 'UnsafeRuntimePathError';
  }
}
export class CursorTryAuthRequiredError extends StackAdapterError {
  constructor() {
    super(
      'cursor-try-auth-required',
      'Cursor try requires CURSOR_API_KEY or CURSOR_AUTH_TOKEN to be set — ' +
        'interactive "agent login" sessions can\'t be safely isolated. ' +
        'Export one of those and retry.',
    );
    this.name = 'CursorTryAuthRequiredError';
  }
}
