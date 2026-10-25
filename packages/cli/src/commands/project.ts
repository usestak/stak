import path from 'node:path';

import type { Command } from 'commander';

import { shortProjectId } from '@stack/memory';

import type {
  MapProjectResult,
  ProjectListRow,
  SetLifecycleResult,
  SetProjectNameResult,
} from '../memory/project-ops.js';

/**
 * `stak project` — a read-only view of logical projects, the explicit
 * `stak project map` binding operation (Phase 15B), and lifecycle management
 * (`archive`/`unarchive`, Phase 15C). No delete: hard deletion is out of scope.
 * Lifecycle (active | archived) is independent of machine availability.
 */
/**
 * Whether an explicit CLI lifecycle change propagated to the account (Cloud). Lifecycle is
 * ONE logical account-level state; the CLI mirrors the local Phase-15 change to Cloud so the
 * two don't split-brain. Offline/failed is reported truthfully so the user can re-run.
 */
export type CloudLifecyclePropagation = 'ok' | 'not-signed-in' | 'failed';
export type LifecycleCommandResult = SetLifecycleResult & {
  cloudPropagation?: CloudLifecyclePropagation;
};

export type ProjectCommandDependencies = {
  projectList(): Promise<ProjectListRow[]>;
  projectMap(options: {
    project: string;
    dir: string;
  }): Promise<MapProjectResult>;
  projectArchive(options: { project: string }): Promise<LifecycleCommandResult>;
  projectUnarchive(options: {
    project: string;
  }): Promise<LifecycleCommandResult>;
  projectSetName(options: {
    project: string;
    name: string;
  }): Promise<SetProjectNameResult>;
  /**
   * Runs `fn` while holding the cross-process Memory lock (spec 2026-10-25).
   * Optional so existing tests keep working; when absent, `fn` runs directly.
   */
  withMemoryLock?<T>(command: string, fn: () => Promise<T>): Promise<T>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

/** For a Local project that is mapped on this machine, show the bound directory's basename
 *  (e.g. `swft`) rather than the generic "local project" — never the path itself. Falls back
 *  to the generic label when unmapped or when no safe basename can be determined. */
export const identityLabel = (row: ProjectListRow): string => {
  if (row.identity.kind === 'git') return row.identity.canonical;
  if (row.discoveredName) return row.discoveredName;
  if (!row.binding) return 'local project';
  const base = path.basename(row.binding).trim();
  return base && base !== '.' && base !== '..' ? base : 'local project';
};

const renderRow = (row: ProjectListRow): string[] => {
  const availability =
    row.availability === 'present'
      ? 'available on this machine'
      : 'not available on this machine';
  const lines = [`${shortProjectId(row.projectId)}  ${identityLabel(row)}`];
  // Local, informational provenance so a human can tell legacy projects apart.
  // It is not identity and does not imply the historical path still exists.
  if (row.recoveryReference)
    lines.push(`    recovered from: ${row.recoveryReference.value}`);
  lines.push(
    `    ${row.files} file${row.files === 1 ? '' : 's'} · ${availability}${
      row.conflict ? ' · identity conflict' : ''
    }`,
  );
  if (row.binding) lines.push(`    mapped to ${row.binding}`);
  else if (row.availability !== 'present')
    lines.push('    map with `stak project map <project> <directory>`');
  lines.push('');
  return lines;
};

export const renderProjectList = (rows: ProjectListRow[]): string => {
  if (rows.length === 0)
    return (
      'No projects known to STAK yet.\n' +
      'Run `stak memory backup` or `stak memory recover` first.\n'
    );
  // Grouped by lifecycle; availability is shown independently per project.
  const active = rows.filter((r) => r.lifecycle === 'active');
  const archived = rows.filter((r) => r.lifecycle === 'archived');
  const lines = ['Logical projects', ''];
  lines.push('ACTIVE', '');
  if (active.length === 0) lines.push('(none)', '');
  for (const row of active) lines.push(...renderRow(row));
  if (archived.length > 0) {
    lines.push('ARCHIVED', '');
    for (const row of archived) lines.push(...renderRow(row));
  }
  return `${lines.join('\n').trimEnd()}\n`;
};

const renderLifecycleResult = (
  result: LifecycleCommandResult,
  target: 'archived' | 'active',
): string => {
  switch (result.status) {
    case 'project-not-found':
      return 'No matching project. Run `stak project` to see known projects.\n';
    case 'ambiguous-selector':
      return `That selector matches ${result.matches.length} projects. Use a full Project ID.\n`;
    case 'ok': {
      const id = shortProjectId(result.projectId);
      const state = target === 'archived' ? 'archived' : 'active';
      const head = result.changed
        ? target === 'archived'
          ? `Archived ${id}.`
          : `${id} is active.`
        : `${id} is already ${state} on this machine.`;
      // Lifecycle is one account-level state; report whether the Cloud was updated so the
      // local and account views never silently diverge.
      const cloud =
        result.cloudPropagation === 'failed'
          ? `Local change saved, but STAK Cloud was not updated (offline or unreachable). ` +
            `Run \`stak project ${target === 'archived' ? 'archive' : 'unarchive'} ${id}\` again when connected.\n`
          : '';
      return `${head}\n${cloud}`;
    }
  }
};

const renderMapResult = (result: MapProjectResult): string => {
  switch (result.status) {
    case 'mapped':
      return (
        `Mapped ${shortProjectId(result.projectId)} to ${result.dir} on this machine.\n` +
        'This is a local binding only; the path is not shared as project identity.\n'
      );
    case 'project-not-found':
      return 'No matching project. Run `stak project` to see known projects.\n';
    case 'ambiguous-selector':
      return `That selector matches ${result.matches.length} projects. Use a full Project ID.\n`;
    case 'not-a-directory':
      return 'That path is not an existing directory.\n';
    case 'git-conflict':
      return (
        `Refused: the directory is a different repository.\n` +
        `  project: ${result.projectGit}\n  directory: ${result.dirGit}\n` +
        'Repository transfers are not reconciled automatically yet.\n'
      );
    case 'identity-conflict':
      return 'Refused: that repository already belongs to another logical project.\n';
  }
};

const renderSetNameResult = (result: SetProjectNameResult): string => {
  switch (result.status) {
    case 'ok':
      return (
        `Renamed ${shortProjectId(result.projectId)} to "${result.name}".\n` +
        'This is presentation metadata only; it does not change the Project ID, ' +
        'mapping, or restore behavior.\n'
      );
    case 'project-not-found':
      return 'No matching project. Run `stak project` to see known projects.\n';
    case 'ambiguous-selector':
      return `That selector matches ${result.matches.length} projects. Use a full Project ID.\n`;
    case 'git-identity':
      return (
        `Refused: this project's name is its Git identity (${result.canonical}) ` +
        'and cannot be renamed.\n'
      );
    case 'invalid-name':
      return result.reason === 'empty'
        ? 'That name is empty.\n'
        : result.reason === 'too-long'
          ? 'That name is too long (200 characters max).\n'
          : 'That name looks like a path and was refused — use a plain name, not a directory.\n';
  }
};

export const registerProjectCommand = (
  program: Command,
  dependencies: ProjectCommandDependencies,
): void => {
  const project = program
    .command('project')
    .description(
      'Review logical projects and map recovered memory to directories',
    );

  // The project registry lives in the Memory store (spec 2026-10-25 §1), so every
  // registry-writing subcommand holds the Memory lock around its read-modify-write.
  // The confirmation prompts come before any registry read, so they stay outside it.
  const locked = <T>(command: string, fn: () => Promise<T>): Promise<T> =>
    dependencies.withMemoryLock ? dependencies.withMemoryLock(command, fn) : fn();

  project
    .command('list', { isDefault: true })
    .description('List logical projects STAK knows about (read-only)')
    .option('--json', 'emit structured JSON only')
    .action(async (options: { json?: boolean }) => {
      const rows = await dependencies.projectList();
      if (options.json) {
        dependencies.writeOut(
          `${JSON.stringify({ projects: rows }, null, 2)}\n`,
        );
        return;
      }
      dependencies.writeOut(renderProjectList(rows));
    });

  project
    .command('map <project> <directory>')
    .description(
      'Authorize a local directory as the restore destination for a project',
    )
    .option('--json', 'emit structured JSON only')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(
      async (
        projectSelector: string,
        directory: string,
        options: { json?: boolean; yes?: boolean },
      ) => {
        if (!options.json && options.yes !== true) {
          const ok = await dependencies.confirm(
            `Map project ${projectSelector} to ${directory} on this machine?`,
          );
          if (!ok) {
            dependencies.writeOut('Cancelled.\n');
            return;
          }
        }
        const result = await locked('stak project map', () =>
          dependencies.projectMap({ project: projectSelector, dir: directory }),
        );
        if (options.json) {
          dependencies.writeOut(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        dependencies.writeOut(renderMapResult(result));
      },
    );

  project
    .command('name <project> <name>')
    .description(
      "Set a logical project's display name (presentation only — never identity)",
    )
    .option('--json', 'emit structured JSON only')
    .action(
      async (
        projectSelector: string,
        name: string,
        options: { json?: boolean },
      ) => {
        const result = await locked('stak project name', () =>
          dependencies.projectSetName({ project: projectSelector, name }),
        );
        if (options.json) {
          dependencies.writeOut(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        dependencies.writeOut(renderSetNameResult(result));
      },
    );

  project
    .command('archive <project>')
    .description(
      'Archive a project without deleting its identity or Memory (reversible)',
    )
    .option('--json', 'emit structured JSON only')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(
      async (
        projectSelector: string,
        options: { json?: boolean; yes?: boolean },
      ) => {
        if (!options.json && options.yes !== true) {
          dependencies.writeOut(
            `Archive ${projectSelector}?\n` +
              'Its Project ID and Memory will be preserved. Archiving does not delete project data.\n',
          );
          const ok = await dependencies.confirm('Archive?');
          if (!ok) {
            dependencies.writeOut('Cancelled.\n');
            return;
          }
        }
        const result = await locked('stak project archive', () =>
          dependencies.projectArchive({ project: projectSelector }),
        );
        if (options.json) {
          dependencies.writeOut(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        dependencies.writeOut(renderLifecycleResult(result, 'archived'));
      },
    );

  // Unarchive is non-destructive (re-activates); it proceeds without a prompt.
  project
    .command('unarchive <project>')
    .description('Return an archived project to active')
    .option('--json', 'emit structured JSON only')
    .action(async (projectSelector: string, options: { json?: boolean }) => {
      const result = await locked('stak project unarchive', () =>
        dependencies.projectUnarchive({ project: projectSelector }),
      );
      if (options.json) {
        dependencies.writeOut(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      dependencies.writeOut(renderLifecycleResult(result, 'active'));
    });
};
