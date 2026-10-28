import { describe, expect, it } from 'vitest';

import {
  CODEX_BUDGET_BYTES,
  CURSOR_FRONTMATTER,
  CURSOR_SECTION_BUDGET_BYTES,
  MANAGED_LINE,
  renderAgentMemory,
} from './render.js';

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

describe('renderAgentMemory', () => {
  it('uses the exact managed line, frontmatter and budget constants', () => {
    expect(MANAGED_LINE).toBe(
      '> Managed by STAK — edit your memory in Claude or with `stak memory`, not here.',
    );
    expect(CURSOR_FRONTMATTER).toBe(
      '---\ndescription: "Project memory from STAK"\nalwaysApply: true\n---\n',
    );
    expect(CODEX_BUDGET_BYTES).toBe(30 * 1024);
    expect(CURSOR_SECTION_BUDGET_BYTES).toBe(24 * 1024);
  });

  it('orders private instructions, then the notes index, then other notes by path', () => {
    const result = renderAgentMemory({
      agent: 'codex',
      documents: [
        { path: 'notes/zeta.md', text: 'Z' },
        { path: 'notes/MEMORY.md', text: 'Index' },
        { path: 'notes/a/deep.md', text: 'Deep' },
        { path: 'instructions/private.md', text: 'Private' },
        { path: 'notes/alpha.md', text: 'A' },
      ],
    });
    expect(result.status).toBe('ok');
    expect(result.omitted).toEqual([]);
    expect(result.content).toBe(
      [
        MANAGED_LINE,
        '## instructions/private.md\n\nPrivate',
        '## notes/MEMORY.md\n\nIndex',
        '## notes/a/deep.md\n\nDeep',
        '## notes/alpha.md\n\nA',
        '## notes/zeta.md\n\nZ',
      ].join('\n\n') + '\n',
    );
  });

  it('never exports agent-specific or unknown documents', () => {
    const result = renderAgentMemory({
      agent: 'cursor',
      documents: [
        { path: 'agents/reviewer/notes.md', text: 'secret agent' },
        { path: 'instructions/other.md', text: 'other' },
        { path: 'notes/kept.md', text: 'kept' },
      ],
    });
    expect(result.content).not.toContain('secret agent');
    expect(result.content).not.toContain('other');
    expect(result.content).toContain('## notes/kept.md\n\nkept');
  });

  it('writes LF only and trims trailing newlines of each document', () => {
    const result = renderAgentMemory({
      agent: 'codex',
      documents: [{ path: 'notes/a.md', text: 'one\r\ntwo\r\n\r\n' }],
      teamAgentsMd: '# Team\r\nRules\r\n',
    });
    expect(result.content).not.toContain('\r');
    expect(result.content).toBe(
      `# Team\nRules\n\n---\n\n${MANAGED_LINE}\n\n## notes/a.md\n\none\ntwo\n`,
    );
  });

  it('starts a Codex file with the managed line when there is no team AGENTS.md', () => {
    const result = renderAgentMemory({
      agent: 'codex',
      documents: [{ path: 'notes/a.md', text: 'A' }],
    });
    expect(result.content.startsWith(`${MANAGED_LINE}\n`)).toBe(true);
  });

  it('puts the Cursor frontmatter first, then the Memory section', () => {
    const result = renderAgentMemory({
      agent: 'cursor',
      documents: [{ path: 'notes/a.md', text: 'A' }],
      teamAgentsMd: '# Team (ignored for Cursor)',
    });
    expect(result.content).toBe(
      `${CURSOR_FRONTMATTER}\n${MANAGED_LINE}\n\n## notes/a.md\n\nA\n`,
    );
  });

  it('drops whole documents from the end and lists them (Cursor section budget)', () => {
    const big = 'x'.repeat(10 * 1024);
    const result = renderAgentMemory({
      agent: 'cursor',
      documents: [
        { path: 'notes/c.md', text: big },
        { path: 'notes/a.md', text: big },
        { path: 'notes/b.md', text: big },
        { path: 'notes/d.md', text: 'small' },
      ],
    });
    expect(result.status).toBe('ok');
    // Order a, b, c, d: a and b fit (≈20 KiB); c does not; d is after c and is
    // dropped too (whole documents from the end, never skipping ahead).
    expect(result.omitted).toEqual(['notes/c.md', 'notes/d.md']);
    expect(result.content).toContain('## notes/a.md');
    expect(result.content).toContain('## notes/b.md');
    expect(result.content).not.toContain('## notes/c.md');
    expect(result.content).not.toContain('small');
    expect(
      result.content.endsWith(
        '\n> 2 notes left out to save space: notes/c.md, notes/d.md.\n',
      ),
    ).toBe(true);
    const section = result.content.slice(CURSOR_FRONTMATTER.length + 1);
    expect(bytes(section)).toBeLessThanOrEqual(CURSOR_SECTION_BUDGET_BYTES);
  });

  it('counts the team AGENTS.md against the Codex whole-file budget', () => {
    const team = 'T'.repeat(25 * 1024);
    const result = renderAgentMemory({
      agent: 'codex',
      documents: [
        { path: 'notes/a.md', text: 'a'.repeat(2 * 1024) },
        { path: 'notes/b.md', text: 'b'.repeat(4 * 1024) },
      ],
      teamAgentsMd: team,
    });
    expect(result.status).toBe('ok');
    expect(result.omitted).toEqual(['notes/b.md']);
    expect(result.content.startsWith(`${team}\n\n---\n\n${MANAGED_LINE}`)).toBe(
      true,
    );
    expect(bytes(result.content)).toBeLessThanOrEqual(CODEX_BUDGET_BYTES);
  });

  it('measures the budget in UTF-8 bytes', () => {
    // 'é' is two bytes: 13 KiB of characters is 26 KiB of bytes, over 24 KiB.
    const result = renderAgentMemory({
      agent: 'cursor',
      documents: [{ path: 'notes/a.md', text: 'é'.repeat(13 * 1024) }],
    });
    expect(result.omitted).toEqual(['notes/a.md']);
  });

  it('reports a team AGENTS.md that alone exceeds the Codex budget', () => {
    const result = renderAgentMemory({
      agent: 'codex',
      documents: [{ path: 'notes/a.md', text: 'A' }],
      teamAgentsMd: 'T'.repeat(CODEX_BUDGET_BYTES + 1),
    });
    expect(result).toEqual({
      status: 'team-agents-md-too-large',
      content: '',
      omitted: [],
    });
  });

  it('renders the managed line alone when there is no Memory', () => {
    expect(renderAgentMemory({ agent: 'codex', documents: [] }).content).toBe(
      `${MANAGED_LINE}\n`,
    );
  });

  it('is deterministic regardless of input order', () => {
    const documents = [
      { path: 'notes/b.md', text: 'B' },
      { path: 'notes/MEMORY.md', text: 'I' },
      { path: 'instructions/private.md', text: 'P' },
      { path: 'notes/a.md', text: 'A' },
    ];
    const first = renderAgentMemory({ agent: 'cursor', documents });
    const second = renderAgentMemory({
      agent: 'cursor',
      documents: [...documents].reverse(),
    });
    expect(second).toEqual(first);
  });
});
