import type { Command } from 'commander';

import { shortProjectId } from '@stack/memory';

import type {
  MapProjectResult,
  ProjectListRow,
} from '../memory/project-ops.js';

/**
 * `stack project` — the smallest read-only view of logical projects, plus the
 * explicit `stack project map` binding operation (Phase 15B). No archive/retire,
 * no delete, no merge: those are later phases.
 */
export type ProjectCommandDependencies = {
  projectList(): Promise<ProjectListRow[]>;
  projectMap(options: {
    project: string;
    dir: string;
  }): Promise<MapProjectResult>;
  confirm(message: string): Promise<boolean>;
  writeOut(value: string): void;
};

const identityLabel = (row: ProjectListRow): string =>
  row.identity.kind === 'git' ? row.identity.canonical : 'local project';

export const renderProjectList = (rows: ProjectListRow[]): string => {
  if (rows.length === 0)
    return (
      'No projects known to Stack yet.\n' +
      'Run `stack memory backup` or `stack memory recover` first.\n'
    );
  const lines = ['Logical projects', ''];
  for (const row of rows) {
    const availability =
      row.availability === 'present'
        ? 'available on this machine'
        : 'not available on this machine';
    lines.push(`${shortProjectId(row.projectId)}  ${identityLabel(row)}`);
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
      lines.push('    map with `stack project map <project> <directory>`');
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
};

const renderMapResult = (result: MapProjectResult): string => {
  switch (result.status) {
    case 'mapped':
      return (
        `Mapped ${shortProjectId(result.projectId)} to ${result.dir} on this machine.\n` +
        'This is a local binding only; the path is not shared as project identity.\n'
      );
    case 'project-not-found':
      return 'No matching project. Run `stack project` to see known projects.\n';
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

export const registerProjectCommand = (
  program: Command,
  dependencies: ProjectCommandDependencies,
): void => {
  const project = program
    .command('project')
    .description(
      'Review logical projects and map recovered memory to directories',
    );

  project
    .command('list', { isDefault: true })
    .description('List logical projects Stack knows about (read-only)')
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
        const result = await dependencies.projectMap({
          project: projectSelector,
          dir: directory,
        });
        if (options.json) {
          dependencies.writeOut(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        dependencies.writeOut(renderMapResult(result));
      },
    );
};
