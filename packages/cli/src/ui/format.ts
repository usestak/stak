/** Human-facing formatting helpers shared across default (non-verbose) output. */

import type { RenamedRequirement } from '@stack/spec';

/** Lines naming each Skill a `stak use`/`stak try` resolution renamed to avoid a name
 *  collision with something already required — empty when nothing was renamed. Never
 *  silent: a renamed Skill isn't a failure, but the user still needs to know its new name
 *  to find/run it. */
export const renamedNote = (renamed: RenamedRequirement[]): string[] =>
  renamed.length === 0
    ? []
    : [
        '',
        'Renamed to avoid a Skill name conflict:',
        ...renamed.map((item) => `  ${item.name} -> ${item.renamedTo}`),
      ];

/** "1 skill" / "3 skills". */
export const skills = (count: number): string =>
  `${count} skill${count === 1 ? '' : 's'}`;

/** "1 change" / "2 changes". */
export const changes = (count: number): string =>
  `${count} change${count === 1 ? '' : 's'}`;

/** Capitalized display name for an agent id. */
export const agentLabel = (agent: string): string =>
  agent === 'claude' ? 'Claude' : agent === 'cursor' ? 'Cursor' : 'Codex';

/** Join non-empty lines and guarantee a single trailing newline. */
export const block = (
  lines: Array<string | false | null | undefined>,
): string =>
  `${lines.filter((line) => line !== false && line != null).join('\n')}\n`;

/**
 * Final review I4: how to clear a LOCAL conflict between an agent's Memory file
 * and STAK's copy (`planSync`'s reasons, plus a moved project's differing
 * folder copies). `stak memory resolve` only handles conflicts between machines
 * (a pending Cloud merge), so it is never the answer here. Each action below
 * was checked against `planSync`'s N/P/C table.
 */
export const localMemoryConflictAdvice = (reason: string): string => {
  switch (reason) {
    case 'adopt-mismatch':
      return "the agent file differs from STAK's copy. To keep STAK's: move the file somewhere else, then run `stak memory materialize`. To keep yours: do that, copy your version back, then run `stak add .`";
    case 'edit-delete':
      return 'edited here but deleted in STAK. To accept the deletion: delete the file. To keep yours: save it under a new file name, delete the original, then run `stak add .`';
    case 'source-conflict':
      return "this project's old and current Claude folders hold different copies. Delete the copy you don't want (old folders are only read), then run `stak add .`";
    default:
      return "changed both here and in STAK since the last sync. STAK can't settle this one automatically yet; both versions are kept and nothing was overwritten";
  }
};
