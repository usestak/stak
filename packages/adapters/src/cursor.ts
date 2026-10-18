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

// The official Cursor Agent CLI's `--version` prints a bare dated build
// version (e.g. `2026.10.16-e3cb207`), not anything containing "cursor" — the
// same `YYYY.M.D(-HH-MM-SS)?-commit` shape its own installer scripts use to
// pick the newest `versions/` directory. A plain `/cursor/i` check therefore
// rejects genuine installs; accept either that literal signal (older/renamed
// builds) or this version shape, which an unrelated `agent` binary on PATH is
// very unlikely to coincidentally print.
const cursorVersionPattern =
  /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[0-9a-f]+$/i;
export const isCursorVersionString = (version: string) =>
  /cursor/i.test(version) || cursorVersionPattern.test(version.trim());

export const detectCursor = (
  options: CursorDetectionOptions = {},
): Promise<AgentDetection> =>
  detectExecutableAgent({
    agent: 'cursor',
    candidates: ['agent', 'cursor-agent'],
    validateVersion: isCursorVersionString,
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
