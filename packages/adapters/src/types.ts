import type {
  AgentDetection,
  AgentId,
  BindingApplyResult,
  BindingPlan,
  BindingVerification,
  LaunchResult,
  ResolvedLocalEnvironment,
} from '@stack/spec';
export type AdapterContext = { stackHome: string; homeDir: string };
export type BindingRemovalRequest = {
  machineId: string;
  environmentEntryIds: string[];
};
export type LaunchContext = { cwd?: string; env?: NodeJS.ProcessEnv };
export interface AgentAdapter {
  readonly id: AgentId;
  detect(): Promise<AgentDetection>;
  planBindings(environment: ResolvedLocalEnvironment): Promise<BindingPlan>;
  applyBindings(
    plan: BindingPlan,
    machineId: string,
  ): Promise<BindingApplyResult>;
  verifyBindings(
    environment: ResolvedLocalEnvironment,
  ): Promise<BindingVerification>;
  removeBindings(request: BindingRemovalRequest): Promise<BindingApplyResult>;
  launch(context: LaunchContext): Promise<LaunchResult>;
}
