import type { SkillAddIssue, SkillAddProposal } from '@stack/core';

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
  }
};

export type StagedMemorySummary = {
  files: number;
  projects: number;
  canonical?: Array<{ projectId: string; imported: number; conflicts: number; guarded: number }>;
};

export const renderSkillAdd = (
  proposal: SkillAddProposal,
  options: { memory?: StagedMemorySummary } = {},
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
    if (options.memory.canonical?.length) {
      for (const project of options.memory.canonical) {
        if (project.imported > 0) lines.push(`  Memory: imported ${project.imported} change(s) for ${project.projectId}`);
        if (project.conflicts > 0) lines.push(`  Memory: ${project.conflicts} conflict(s) in ${project.projectId} — resolve with \`stak memory resolve\``);
        if (project.guarded > 0) lines.push(`  Memory: ${project.guarded} path(s) will be regenerated for ${project.projectId} — run \`stak memory materialize\``);
      }
    }
  }
  if (proposal.targets.length > 0 || options.memory)
    lines.push('', 'Run `stak push` to sync main to STAK Cloud.');
  return block(lines);
};
