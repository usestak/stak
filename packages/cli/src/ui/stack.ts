import type { StackRemoveProposal, StackUseProposal } from '@stack/core';

export const renderStackUse = (proposal: StackUseProposal, dryRun = false) =>
  `${dryRun ? 'Previewing' : 'Using'} local STAK: ${proposal.loaded.version.name}\n\nSTAK Skills               ${proposal.loaded.version.requirements.length}\nAlready satisfied         ${proposal.summary.alreadySatisfied}\nNew desired Skills        ${proposal.summary.newSkills}\nOptional skipped          ${proposal.summary.optionalSkipped}\nHard conflicts            ${proposal.summary.hardConflicts}\n\nmain will become:\nDirect Skills             ${proposal.summary.directSkills}\nSTAK layers               ${proposal.summary.stackLayers}\nResolved Skills           ${proposal.summary.resolvedSkills}\n`;

export const renderStackRemove = (proposal: StackRemoveProposal) =>
  `Removing STAK: ${proposal.layer.name}\n\nSTAK requirements         ${proposal.summary.requirements}\nSkills still required     ${proposal.summary.stillRequired}\nSkills no longer desired  ${proposal.summary.noLongerDesired}\n\nmain after removal:\nDirect Skills             ${proposal.summary.directSkills}\nSTAK layers               ${proposal.summary.stackLayers}\nResolved Skills           ${proposal.summary.resolvedSkills}\n`;
