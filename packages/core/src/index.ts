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
export { applySkillAdd, prepareSkillAdd } from './add.js';
export type {
  ApplySkillAddOptions,
  PrepareSkillAddOptions,
  SkillAddIssue,
  SkillAddProposal,
  SkillAddTarget,
} from './add.js';
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
  prepareSkillRemove,
  applySkillRemove,
  resolveSkillSelector,
  setSkillPaused,
} from './composition.js';
export type {
  StackUseProposal,
  StackRemoveProposal,
  SkillRemoveProposal,
  SkillSelectorResult,
  SetSkillPausedResult,
} from './composition.js';
export {
  projectedLocalEnvironment,
  loadProjectedLocalEnvironment,
} from './projection.js';
export {
  approveSkillSourceVersion,
  diffSkillTrees,
  gitLsRemoteRef,
  resolvePublicStackSourceLatest,
  resolveSkillSourceLatest,
} from './skill-source.js';
export type {
  ApproveSkillResult,
  CandidateRevision,
  IngestCandidate,
  PublicStackLatestResolver,
  PublicStackLocator,
  PublicStackVersionId,
  ResolveRemoteRef,
  SkillFileChange,
  SkillFileChangeKind,
  SkillSourceDiff,
  SkillTreeDiff,
  SourceLatestResult,
} from './skill-source.js';
export { preserveTrialStack, resolveTrialStack } from './trial.js';
export type { TrialStackResolution } from './trial.js';
export {
  buildCloudEnvironmentBundle,
  canonicalJson,
  computeEnvironmentDigest,
} from './cloud-bundle.js';
export type { BuildCloudEnvironmentBundleOptions } from './cloud-bundle.js';
export {
  readMachineSyncState,
  readEnvironmentSyncState,
  writeEnvironmentSyncState,
} from './sync-metadata.js';
export { restoreReference, spawnGit } from './git-reference.js';
export type {
  GitCommandResult,
  GitExecutor,
  RestoreReferenceOptions,
} from './git-reference.js';
export { applyCloudRestore, planCloudRestore } from './cloud-restore.js';
export type {
  ApplyCloudRestoreOptions,
  CloudRestorePlan,
  CloudRestoreResult,
} from './cloud-restore.js';
export { checkEnvironmentCloudSync } from './cloud-status.js';
export type {
  CheckEnvironmentCloudSyncOptions,
  EnvironmentCloudSyncState,
} from './cloud-status.js';
export { applyPush, preparePush } from './cloud-push.js';
export type {
  ApplyPushOptions,
  ApplyPushResult,
  PreparePushOptions,
  PushConflict,
  PushPlan,
} from './cloud-push.js';
export { applyPull, preparePull } from './cloud-pull.js';
export type {
  ApplyPullOptions,
  ApplyPullResult,
  PreparePullOptions,
  PullConflict,
  PullPlan,
} from './cloud-pull.js';
export {
  buildPublicStackBundle,
  publicBundleDigestInput,
  resolvePublishSource,
} from './public-stack.js';
export type { PublishSource } from './public-stack.js';
export {
  publicBundleToImportedVersion,
  resolvePublicStackSource,
} from './remote-source.js';
export type { ResolvedPublicStackSource } from './remote-source.js';
export { applyRemoteStackUse, prepareRemoteStackUse } from './composition.js';
export type { StackRemoteUseProposal } from './composition.js';
export { resolveOwnedStackSource } from './owned-stack-source.js';
export type { ResolvedOwnedStackSource } from './owned-stack-source.js';
export { applyOwnedStackUse, prepareOwnedStackUse } from './composition.js';
export type { StackOwnedUseProposal } from './composition.js';
export { applyPublish, preparePublish } from './cloud-publish.js';
export type { PublishClient, PublishPlan } from './cloud-publish.js';
export { preserveRemoteTrialStack, resolveRemoteTrialStack } from './trial.js';
export type { RemoteTrialResolution } from './trial.js';
export {
  buildReviewArtifactFiles,
  materializeExactRevision,
  DEFAULT_REVIEW_BOUNDS,
} from './skill-check.js';
export type {
  ReviewArtifactFileRecord,
  ReviewArtifactFilesResult,
  ReviewBounds,
  ReviewFileSide,
} from './skill-check.js';
