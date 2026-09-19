export {
  StackStateError,
  getOrCreateMachineIdentity,
  loadMainEnvironment,
  resolveStackHome,
} from './state.js';
export type {
  GetMachineIdentityOptions,
  LoadMainEnvironmentOptions,
  LoadedEnvironmentState,
  ResolveStackHomeOptions,
} from './state.js';
export { initializeMainEnvironment } from './initialize.js';
export type {
  InitializeMainEnvironmentOptions,
  InitializeMainEnvironmentResult,
} from './initialize.js';
export { diffMainEnvironment, statusMainEnvironment } from './status.js';
export type { ObserveMainEnvironmentOptions } from './status.js';
export { selectRestorationStrategy } from './restoration.js';
export type { SelectRestorationStrategyOptions } from './restoration.js';
export { StackStoreError } from '@stack/store';
export {
  loadLocalStack,
  stackVersionHash,
  StackCompositionError,
  StackCycleError,
} from './stack-loader.js';
export type { LoadedLocalStack } from './stack-loader.js';
export { resolveEnvironment, importedVersionKey } from './resolver.js';
export {
  prepareStackUse,
  applyStackUse,
  prepareStackRemove,
  applyStackRemove,
} from './composition.js';
export type { StackUseProposal, StackRemoveProposal } from './composition.js';
export { preserveTrialStack, resolveTrialStack } from './trial.js';
export type { TrialStackResolution } from './trial.js';
