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
