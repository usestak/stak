import { describe, expect, it } from 'vitest';

import type { SkillSource } from '@stack/spec';

import { selectRestorationStrategy } from './restoration.js';

const contentHash = `sha256:${'a'.repeat(64)}`;
const choose = (sources: SkillSource[]) =>
  selectRestorationStrategy({
    contentHash,
    sources,
    snapshotId: 'snap_86526e9e-3c97-4b0f-8bcb-1a65660568cf',
  });
const git = (
  overrides: Partial<Extract<SkillSource, { type: 'git' }>> = {},
) => ({
  type: 'git' as const,
  remote: 'https://github.com/example/skills.git',
  revision: 'abc123',
  path: 'skills/demo',
  clean: true,
  ...overrides,
});

describe('selectRestorationStrategy', () => {
  it('uses a clean portable Git observation as an exact reference', () => {
    expect(choose([git()])).toEqual({
      strategy: 'reference',
      reference: {
        remote: 'https://github.com/example/skills.git',
        revision: 'abc123',
        path: 'skills/demo',
        expectedContentHash: contentHash,
      },
    });
  });

  it.each([
    ['modified Git content', [git({ clean: false })], 'modified-source'],
    [
      'unverified Git cleanliness',
      [git({ clean: undefined })],
      'modified-source',
    ],
    [
      'a machine-local Git remote',
      [git({ remote: 'C:\\repos\\skills' })],
      'non-portable-source',
    ],
    [
      'a Git source without a remote',
      [git({ remote: undefined })],
      'non-portable-source',
    ],
    ['local provenance', [{ type: 'local' as const }], 'local'],
    ['unknown provenance', [{ type: 'unknown' as const }], 'unknown-source'],
  ])('uses a snapshot for %s', (_label, sources, reason) => {
    expect(choose(sources)).toMatchObject({ strategy: 'snapshot', reason });
  });

  it('uses a snapshot when multiple distinct portable references are ambiguous', () => {
    expect(
      choose([
        git(),
        git({ remote: 'ssh://git@example.com/other.git', revision: 'def456' }),
      ]),
    ).toMatchObject({ strategy: 'snapshot', reason: 'ambiguous-source' });
  });

  it('selects one portable reference from a duplicate that also has local evidence', () => {
    expect(choose([git(), { type: 'local' }])).toMatchObject({
      strategy: 'reference',
      reference: { remote: 'https://github.com/example/skills.git' },
    });
  });
});
