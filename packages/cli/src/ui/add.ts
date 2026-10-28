import type { SkillAddIssue, SkillAddProposal } from '@stack/core';

import type { ProjectFoldNote } from '../memory/project-fold.js';
import { projectFoldNotes } from './cloud.js';
import { block, skills } from './format.js';

const issueLine = (issue: SkillAddIssue): string => {
  switch (issue.status) {
    case 'not-found':
      return `${issue.selector}: no untracked or modified Skill by that name was found.`;
    case 'ambiguous':
      return `${issue.selector}: ambiguous — matches more than one Skill (${issue.candidates.join('; ')}).`;
    case 'invalid':
      return `${issue.selector}: this Skill's SKILL.md is invalid and cannot be added.`;
    case 'stack-origin':
      return `${issue.name}: comes from an active STAK layer, not a direct Skill in main. Remove the STAK layer to change it, or use \`stak use\` to update it.`;
    case 'already-satisfied':
      return `${issue.name}: already matches what's in main. Nothing to add.`;
    case 'missing':
      return `${issue.name}: tracked in main but missing on disk, or could not be verified. Run \`stak remove ${issue.name}\` if removal is intentional.`;
    case 'not-installed':
      return `${issue.name}: already in main, just not installed on this machine yet. Nothing to add. Run \`stak run <agent>\` (e.g. \`stak run codex\`) to set it up.`;
  }
};

export type StagedMemorySummary = {
  files: number;
  projects: number;
  canonical?: Array<{
    projectId: string;
    imported: number;
    conflicts: number;
    guarded: number;
  }>;
  /** Project identities with genuinely ambiguous resolution (more than one existing
   * Project ID claims or is bound to the same identity) — never staged. No existing
   * `stak project` subcommand can merge/remove a claim, so this is reported as a
   * standing conflict, never as something the user can resolve today. */
  conflictedProjects?: number;
  /** REGISTERED project identities (a claim or a binding already exists) whose
   * directory could not be located at all — never staged. Named and actionable:
   * `stak project map <project> <dir>` is the escape hatch. */
  unlocatableProjects?: Array<{ projectId: string; name: string }>;
  /** Stale Claude memory folders with no Project ID at all AND no locatable
   * directory — a quieter, un-actionable count distinct from `unlocatableProjects`
   * (there is no project here to name or map). */
  untrackedFolders?: number;
  /** Spec §4.2.1: former Project IDs folded into their surviving ones. */
  folded?: ProjectFoldNote[];
};

export const renderSkillAdd = (
  proposal: SkillAddProposal,
  options: {
    memory?: StagedMemorySummary;
    /** Spec 2026-10-28: notes from refreshing the Codex/Cursor Memory files. */
    agentNotes?: string[];
  } = {},
): string => {
  if (
    proposal.targets.length === 0 &&
    proposal.issues.length === 0 &&
    !options.memory
  )
    return block(['Nothing to add.']);
  const lines: Array<string | false> = [];
  if (proposal.targets.length > 0) {
    lines.push(`Added ${skills(proposal.targets.length)} to main.`, '');
    for (const target of proposal.targets)
      lines.push(`  ${target.kind === 'new' ? '+' : '~'} ${target.name}`);
  }
  if (proposal.issues.length > 0) {
    if (proposal.targets.length > 0) lines.push('');
    lines.push('Not added:');
    for (const issue of proposal.issues) lines.push(`  ${issueLine(issue)}`);
  }
  if (options.memory) {
    if (lines.length > 0) lines.push('');
    lines.push(
      'Memory',
      `  staged ${options.memory.files} file${options.memory.files === 1 ? '' : 's'}` +
        ` across ${options.memory.projects} project${options.memory.projects === 1 ? '' : 's'}`,
    );
    for (const note of projectFoldNotes(options.memory.folded))
      lines.push(`  Memory: ${note}.`);
    if (options.memory.canonical?.length) {
      for (const project of options.memory.canonical) {
        if (project.imported > 0)
          lines.push(
            `  Memory: imported ${project.imported} change(s) for ${project.projectId}`,
          );
        // Final review I4: local agent-vs-STAK conflicts; `stak status` lists each with its fix.
        if (project.conflicts > 0)
          lines.push(
            `  Memory: ${project.conflicts} conflict(s) between agent files and STAK in ${project.projectId}, not added — run \`stak status\` for how to fix each`,
          );
        if (project.guarded > 0)
          lines.push(
            `  Memory: ${project.guarded} path(s) will be regenerated for ${project.projectId} — run \`stak memory materialize\``,
          );
      }
    }
    if (options.memory.conflictedProjects)
      lines.push(
        `  Memory: ${options.memory.conflictedProjects} project(s) have conflicting identities — STAK won't guess which is correct; left unchanged`,
      );
    if (options.memory.unlocatableProjects?.length)
      lines.push(
        `  Memory: ${options.memory.unlocatableProjects.length} project(s) couldn't be located on this machine` +
          ` (${options.memory.unlocatableProjects.map((p) => p.name).join(', ')})` +
          ' — run `stak project map <project> <dir>`',
      );
    if (options.memory.untrackedFolders)
      lines.push(
        `  Memory: ${options.memory.untrackedFolders} Claude memory folder(s) have no project folder on this machine and aren't tracked`,
      );
    for (const note of options.agentNotes ?? []) lines.push(`  ${note}`);
  }
  if (proposal.targets.length > 0 || options.memory)
    lines.push('', 'Run `stak push` to sync main to STAK Cloud.');
  return block(lines);
};
