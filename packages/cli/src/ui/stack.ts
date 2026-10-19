import type {
  SkillRemoveProposal,
  StackRemoveProposal,
  StackUseProposal,
} from '@stack/core';

export const renderStackUse = (proposal: StackUseProposal, dryRun = false) =>
  `${dryRun ? 'Previewing' : 'Using'} local STAK: ${proposal.loaded.version.name}\n\nSTAK Skills               ${proposal.loaded.version.requirements.length}\nAlready satisfied         ${proposal.summary.alreadySatisfied}\nNew desired Skills        ${proposal.summary.newSkills}\nOptional skipped          ${proposal.summary.optionalSkipped}\nHard conflicts            ${proposal.summary.hardConflicts}\n\nmain will become:\nDirect Skills             ${proposal.summary.directSkills}\nSTAK layers               ${proposal.summary.stackLayers}\nResolved Skills           ${proposal.summary.resolvedSkills}\n`;

export const renderStackRemove = (proposal: StackRemoveProposal) =>
  `Removing STAK: ${proposal.layer.name}\n\nSTAK requirements         ${proposal.summary.requirements}\nSkills still required     ${proposal.summary.stillRequired}\nSkills no longer desired  ${proposal.summary.noLongerDesired}\n\nmain after removal:\nDirect Skills             ${proposal.summary.directSkills}\nSTAK layers               ${proposal.summary.stackLayers}\nResolved Skills           ${proposal.summary.resolvedSkills}\n`;

export const isSkillRemoveProposal = (
  proposal: StackRemoveProposal | SkillRemoveProposal,
): proposal is SkillRemoveProposal => !('layer' in proposal);

export const renderSkillRemove = (proposal: SkillRemoveProposal) =>
  `Removing Skill: ${proposal.name}\n\nmain after removal:\nDirect Skills             ${proposal.manifest.skills.length}\nSTAK layers               ${proposal.manifest.stacks.length}\nResolved Skills           ${proposal.resolved.skills.length}\n`;

export const removedName = (
  proposal: StackRemoveProposal | SkillRemoveProposal,
): string => (isSkillRemoveProposal(proposal) ? proposal.name : proposal.layer.name);

export const renderRemove = (
  proposal: StackRemoveProposal | SkillRemoveProposal,
): string =>
  isSkillRemoveProposal(proposal)
    ? renderSkillRemove(proposal)
    : renderStackRemove(proposal);
