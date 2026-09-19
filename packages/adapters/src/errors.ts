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
  constructor() {
    super('agent-not-installed', 'Codex CLI was not found on this machine.');
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
