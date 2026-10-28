/**
 * Pure renderer for cross-agent Project Memory (spec 2026-10-28 §4).
 *
 * Turns a project's present canonical Memory documents into the exact bytes STAK
 * writes for Codex (`AGENTS.override.md`) or Cursor (`.cursor/rules/stak-memory.mdc`).
 * Order and size budget are applied here and nowhere else. Output is always LF.
 */

export const AGENT_EXPORT_IDS = ['codex', 'cursor'] as const;
export type AgentExportId = (typeof AGENT_EXPORT_IDS)[number];

/** Codex: the whole `AGENTS.override.md` (team `AGENTS.md` + STAK section). */
export const CODEX_BUDGET_BYTES = 30 * 1024;
/** Cursor: the STAK section only (the frontmatter is not counted). */
export const CURSOR_SECTION_BUDGET_BYTES = 24 * 1024;

export const MANAGED_LINE =
  '> Managed by STAK — edit your memory in Claude or with `stak memory`, not here.';

export const CURSOR_FRONTMATTER =
  '---\ndescription: "Project memory from STAK"\nalwaysApply: true\n---\n';

/** Placed between the team's `AGENTS.md` and the STAK section. */
export const CODEX_SEPARATOR = '\n\n---\n\n';

export const omittedLine = (paths: readonly string[]): string =>
  `> ${paths.length} notes left out to save space: ${paths.join(', ')}.`;

export type AgentMemoryDocument = { path: string; text: string };

export type RenderAgentMemoryInput = {
  agent: AgentExportId;
  documents: ReadonlyArray<AgentMemoryDocument>;
  teamAgentsMd?: string;
};

export type RenderAgentMemoryResult = {
  content: string;
  omitted: string[];
  status: 'ok' | 'team-agents-md-too-large';
};

const PRIVATE_INSTRUCTIONS = 'instructions/private.md';
const NOTES_INDEX = 'notes/MEMORY.md';

const toLf = (text: string): string => text.replace(/\r\n/g, '\n');
const trimTrailingNewlines = (text: string): string => text.replace(/\n+$/, '');
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** §4.1 order: private instructions, the notes index, then every other note by
 * path. Anything else (notably `agents/**`) is never exported to another agent. */
const orderDocuments = (
  documents: ReadonlyArray<AgentMemoryDocument>,
): AgentMemoryDocument[] => {
  const seen = new Set<string>();
  const unique = documents.filter((document) => {
    if (seen.has(document.path)) return false;
    seen.add(document.path);
    return true;
  });
  const first = unique.filter((d) => d.path === PRIVATE_INSTRUCTIONS);
  const index = unique.filter((d) => d.path === NOTES_INDEX);
  const notes = unique
    .filter((d) => d.path.startsWith('notes/') && d.path !== NOTES_INDEX)
    .sort((a, b) => compare(a.path, b.path));
  return [...first, ...index, ...notes];
};

const documentBlock = (document: AgentMemoryDocument): string => {
  const body = trimTrailingNewlines(toLf(document.text));
  return body.length > 0
    ? `## ${document.path}\n\n${body}`
    : `## ${document.path}`;
};

const section = (blocks: readonly string[], omitted: readonly string[]) =>
  [MANAGED_LINE, ...blocks, ...(omitted.length ? [omittedLine(omitted)] : [])]
    .join('\n\n')
    .concat('\n');

export const renderAgentMemory = (
  input: RenderAgentMemoryInput,
): RenderAgentMemoryResult => {
  const ordered = orderDocuments(input.documents);
  const blocks = ordered.map(documentBlock);

  const team =
    input.agent === 'codex' && input.teamAgentsMd !== undefined
      ? trimTrailingNewlines(toLf(input.teamAgentsMd))
      : '';
  const prefix =
    input.agent === 'codex'
      ? team.length > 0
        ? `${team}${CODEX_SEPARATOR}`
        : ''
      : `${CURSOR_FRONTMATTER}\n`;
  // Bytes of `prefix` that count against the budget.
  const countedPrefix = input.agent === 'codex' ? byteLength(prefix) : 0;
  const budget =
    input.agent === 'codex' ? CODEX_BUDGET_BYTES : CURSOR_SECTION_BUDGET_BYTES;

  if (input.agent === 'codex' && byteLength(team) > budget)
    return { content: '', omitted: [], status: 'team-agents-md-too-large' };

  // Keep the longest prefix of documents that fits, dropping whole documents from
  // the end. Sizes are computed arithmetically to stay linear in the input size.
  const blockBytes = blocks.map(byteLength);
  let keptBytes = blockBytes.reduce((sum, size) => sum + size + 2, 0);
  for (let kept = blocks.length; kept >= 0; kept -= 1) {
    if (kept < blocks.length) keptBytes -= (blockBytes[kept] ?? 0) + 2;
    const omitted = ordered.slice(kept).map((document) => document.path);
    const size =
      countedPrefix +
      byteLength(MANAGED_LINE) +
      keptBytes +
      (omitted.length ? byteLength(omittedLine(omitted)) + 2 : 0) +
      1;
    if (size <= budget) {
      const content = prefix + section(blocks.slice(0, kept), omitted);
      return { content, omitted, status: 'ok' };
    }
  }

  // Not even the managed line and the omitted list fit. For Codex this means the
  // team file leaves no room for a STAK section at all.
  if (input.agent === 'codex')
    return { content: '', omitted: [], status: 'team-agents-md-too-large' };
  const omitted = ordered.map((document) => document.path);
  return { content: prefix + section([], omitted), omitted, status: 'ok' };
};
