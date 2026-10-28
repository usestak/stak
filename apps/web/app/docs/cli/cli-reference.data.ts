export type CliCommandGroup =
  | 'Authentication'
  | 'Environment'
  | 'STAKs'
  | 'Projects'
  | 'Memory'
  | 'Cloud & Publishing'
  | 'Maintenance';

export interface CliCommandMeta {
  name: string;
  group: CliCommandGroup;
  /** Documented nested subcommands (e.g. `memory agents`). cli-reference.test.ts
   * fails if one is not registered in that command's packages/cli/src/commands
   * file. */
  subcommands?: string[];
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
  { name: 'add', group: 'Environment' },
  { name: 'diff', group: 'Environment' },
  { name: 'scan', group: 'Environment' },
  { name: 'open', group: 'Environment' },
  { name: 'use', group: 'STAKs' },
  { name: 'remove', group: 'STAKs' },
  { name: 'run', group: 'STAKs' },
  { name: 'try', group: 'STAKs' },
  { name: 'skill', group: 'STAKs' },
  { name: 'project', group: 'Projects' },
  {
    name: 'memory',
    group: 'Memory',
    subcommands: [
      'scan',
      'backup',
      'status',
      'recover',
      'restore',
      'protect',
      'history',
      'resolve',
      'diff',
      'materialize',
      'agents',
      'unlock',
    ],
  },
  { name: 'push', group: 'Cloud & Publishing' },
  { name: 'pull', group: 'Cloud & Publishing' },
  { name: 'publish', group: 'Cloud & Publishing' },
  { name: 'upgrade', group: 'Maintenance' },
];
