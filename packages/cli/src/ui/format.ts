/** Human-facing formatting helpers shared across default (non-verbose) output. */

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
