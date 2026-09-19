import type { AgentDetection } from '@stack/spec';
import { FilesystemSkillAdapter, detectExecutableAgent } from './codex.js';
import type { CodexAdapterOptions, findExecutableOnPath } from './codex.js';

export type ClaudeDetectionOptions = {
  env?: NodeJS.ProcessEnv;
  findExecutable?: typeof findExecutableOnPath;
  runVersion?: (file: string, args: string[]) => Promise<string | undefined>;
};

export const detectClaude = (
  options: ClaudeDetectionOptions = {},
): Promise<AgentDetection> =>
  detectExecutableAgent({
    agent: 'claude',
    candidates: ['claude'],
    ...options,
  });

export class ClaudeAdapter extends FilesystemSkillAdapter {
  constructor(options: CodexAdapterOptions) {
    super({
      ...options,
      agent: 'claude',
      targetRootKind: 'claude',
      detect: options.detect ?? (() => detectClaude(options.detection)),
    });
  }
}
