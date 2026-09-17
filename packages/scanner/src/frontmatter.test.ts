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
});
