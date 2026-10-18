export type CliCommandGroup =
  | 'Authentication'
  | 'Environment'
  | 'STAKs'
  | 'Projects'
  | 'Memory'
  | 'Cloud & Publishing';

export interface CliCommandMeta {
  name: string;
  group: CliCommandGroup;
}

// Mirrors the `register*Command(program, dependencies)` calls in
// packages/cli/src/program.ts's `createProgram` exactly — one entry per
// registered top-level command. cli-reference.test.ts fails if this list
// drifts from what program.ts actually registers.
export const CLI_REFERENCE_COMMANDS: CliCommandMeta[] = [
  { name: 'login', group: 'Authentication' },
  { name: 'logout', group: 'Authentication' },
  { name: 'whoami', group: 'Authentication' },
  { name: 'init', group: 'Environment' },
  { name: 'status', group: 'Environment' },
  { name: 'diff', group: 'Environment' },
  { name: 'scan', group: 'Environment' },
  { name: 'open', group: 'Environment' },
  { name: 'use', group: 'STAKs' },
  { name: 'remove', group: 'STAKs' },
  { name: 'run', group: 'STAKs' },
  { name: 'try', group: 'STAKs' },
  { name: 'skill', group: 'STAKs' },
  { name: 'project', group: 'Projects' },
  { name: 'memory', group: 'Memory' },
  { name: 'push', group: 'Cloud & Publishing' },
  { name: 'pull', group: 'Cloud & Publishing' },
  { name: 'publish', group: 'Cloud & Publishing' },
];
