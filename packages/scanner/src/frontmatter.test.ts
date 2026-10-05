import { describe, expect, it } from 'vitest';

import { parseSkillFile } from './frontmatter.js';

describe('parseSkillFile', () => {
  it('preserves additional frontmatter fields', () => {
    const result = parseSkillFile(
      '---\nname: demo\ndescription: Demo skill\ncategory: test\n---\n# Demo',
    );

    expect(result).toEqual({
      metadata: { name: 'demo', description: 'Demo skill', category: 'test' },
    });
  });

  it('reports malformed YAML without throwing', () => {
    const result = parseSkillFile('---\nname: [broken\n---\n');

    expect(result).toMatchObject({ error: expect.stringContaining('YAML') });
  });

  it.each([
    ['name', '---\ndescription: Demo\n---\n'],
    ['description', '---\nname: demo\n---\n'],
  ])('requires %s', (field, source) => {
    expect(parseSkillFile(source)).toMatchObject({
      error: expect.stringContaining(field),
    });
  });

  // Declared capabilities (P2, contract §7).
  it('parses a declared capabilities block (tri-state: present true/false)', () => {
    const result = parseSkillFile(
      '---\nname: demo\ndescription: Demo skill\ncapabilities:\n  readFiles: true\n  network: false\n---\n# Demo',
    );
    expect(result.metadata?.capabilities).toEqual({
      readFiles: true,
      network: false,
    });
    // writeFiles / runCommands were not declared → ABSENT, never defaulted to false.
    expect('writeFiles' in (result.metadata?.capabilities ?? {})).toBe(false);
    expect('runCommands' in (result.metadata?.capabilities ?? {})).toBe(false);
  });

  it('leaves capabilities undefined when no block is declared (not-declared, not false)', () => {
    const result = parseSkillFile(
      '---\nname: demo\ndescription: Demo skill\n---\n# Demo',
    );
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.capabilities).toBeUndefined();
  });

  it('loads a pre-P2 SKILL.md (no capabilities field) unchanged', () => {
    const result = parseSkillFile(
      '---\nname: legacy\ndescription: Legacy skill\ncategory: old\n---\nbody',
    );
    expect(result).toEqual({
      metadata: {
        name: 'legacy',
        description: 'Legacy skill',
        category: 'old',
      },
    });
  });

  it('round-trips unknown declared capability keys (forward-compatible)', () => {
    const result = parseSkillFile(
      '---\nname: demo\ndescription: Demo skill\ncapabilities:\n  readFiles: true\n  futureThing: true\n---\n',
    );
    expect(result.metadata?.capabilities).toEqual({
      readFiles: true,
      futureThing: true,
    });
  });
});
