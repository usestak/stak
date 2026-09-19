import os from 'node:os';
import path from 'node:path';
import type { AgentDetection } from '@stack/spec';
import { FilesystemSkillAdapter, detectExecutableAgent } from './codex.js';
import type { CodexAdapterOptions, findExecutableOnPath } from './codex.js';

export type CursorDetectionOptions = {
  env?: NodeJS.ProcessEnv;
  findExecutable?: typeof findExecutableOnPath;
  runVersion?: (file: string, args: string[]) => Promise<string | undefined>;
};

export const detectCursor = (
  options: CursorDetectionOptions = {},
): Promise<AgentDetection> =>
  detectExecutableAgent({
    agent: 'cursor',
    candidates: ['agent', 'cursor-agent'],
    validateVersion: (version) => /cursor/i.test(version),
    ...options,
  });

export class CursorAdapter extends FilesystemSkillAdapter {
  constructor(options: CodexAdapterOptions) {
    const home = options.homeDir ?? os.homedir();
    super({
      ...options,
      agent: 'cursor',
      targetRootKind: 'agents',
      visibilityRoots: [
        path.resolve(home, '.agents', 'skills'),
        path.resolve(home, '.cursor', 'skills'),
        path.resolve(home, '.claude', 'skills'),
        path.resolve(home, '.codex', 'skills'),
      ],
      detect: options.detect ?? (() => detectCursor(options.detection)),
    });
  }
}
