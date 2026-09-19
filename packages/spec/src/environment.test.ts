import { describe, expect, it } from 'vitest';

import {
  environmentDiffSchema,
  environmentLockSchema,
  environmentManifestSchema,
  environmentStatusSchema,
  machineEnvironmentBaselineSchema,
  machineIdentitySchema,
} from './environment.js';

const source = { type: 'local' as const };

describe('Phase 2 contracts', () => {
  it('parses portable desired state without physical paths', () => {
    const manifest = environmentManifestSchema.parse({
      schemaVersion: 1,
      name: 'main',
      skills: [
        { id: 'skill_12345678', name: 'design', requirement: 'required' },
      ],
      stacks: [],
      overrides: {},
    });
    const lock = environmentLockSchema.parse({
      schemaVersion: 1,
      resolvedAt: '2026-09-19T00:00:00.000Z',
      skills: {
        skill_12345678: {
          name: 'design',
          description: 'Design help',
          contentHash: `sha256:${'a'.repeat(64)}`,
          observedSources: [source],
        },
      },
    });

    expect(JSON.stringify({ manifest, lock })).not.toContain('/Users/');
  });

  it('parses machine identity and machine-specific placement state', () => {
    expect(
      machineIdentitySchema.parse({
        schemaVersion: 1,
        machineId: '86526e9e-3c97-4b0f-8bcb-1a65660568cf',
        createdAt: '2026-09-19T00:00:00.000Z',
        platform: 'win32',
        arch: 'x64',
      }).machineId,
    ).toBeTruthy();

    const baseline = machineEnvironmentBaselineSchema.parse({
      schemaVersion: 1,
      machineId: '86526e9e-3c97-4b0f-8bcb-1a65660568cf',
      environment: 'main',
      capturedAt: '2026-09-19T00:00:00.000Z',
      skills: {
        skill_12345678: {
          contentHash: `sha256:${'a'.repeat(64)}`,
          locations: [
            {
              path: 'C:/Users/test/.codex/skills/design',
              rootPath: 'C:/Users/test/.codex/skills',
              rootKind: 'codex',
              scope: 'global',
              isSymlink: false,
              contentHash: `sha256:${'a'.repeat(64)}`,
              source,
            },
          ],
        },
      },
    });
    expect(baseline.skills.skill_12345678?.locations[0]?.path).toContain(
      '.codex',
    );
  });

  it('parses structured status and diff results', () => {
    const common = {
      schemaVersion: 1 as const,
      environment: 'main',
      observedAt: '2026-09-19T00:00:00.000Z',
      desiredCount: 0,
      skills: [],
      untracked: [],
      placementDrift: [],
      invalidSkills: [],
      rootFailures: [],
      summary: {
        satisfied: 0,
        modified: 0,
        missing: 0,
        uncertain: 0,
        untracked: 0,
        placementAdded: 0,
        placementRemoved: 0,
        placementChanged: 0,
        invalid: 0,
        rootFailures: 0,
      },
    };
    const status = environmentStatusSchema.parse(common);
    expect(
      environmentDiffSchema.parse({ ...common, entries: status.skills }),
    ).toBeTruthy();
  });
});
