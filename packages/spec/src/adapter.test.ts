import { describe, expect, it } from 'vitest';

import {
  bindingPlanSchema,
  bindingRegistrySchema,
  resolvedLocalEnvironmentSchema,
} from './adapter.js';

const hash = `sha256:${'a'.repeat(64)}`;

describe('adapter schemas', () => {
  it('parses a machine-specific Codex binding registry', () => {
    expect(
      bindingRegistrySchema.parse({
        schemaVersion: 1,
        agent: 'codex',
        machineId: '00000000-0000-4000-8000-000000000000',
        targetRoot: 'C:/Users/test/.agents/skills',
        bindings: [
          {
            environment: 'main',
            environmentEntryId: 'skill_12345678',
            skillName: 'demo',
            contentHash: hash,
            targetPath: 'C:/Users/test/.agents/skills/demo',
            createdAt: '2026-09-19T00:00:00.000Z',
          },
        ],
      }).bindings,
    ).toHaveLength(1);
  });

  it('parses resolved local Environment input without placement paths', () => {
    expect(
      resolvedLocalEnvironmentSchema.parse({
        name: 'main',
        machineId: '00000000-0000-4000-8000-000000000000',
        skills: [
          { entryId: 'skill_12345678', name: 'demo', contentHash: hash },
        ],
      }).skills[0]?.name,
    ).toBe('demo');
  });

  it('parses structured blocking plan states', () => {
    const plan = bindingPlanSchema.parse({
      schemaVersion: 1,
      agent: 'codex',
      environment: 'main',
      targetRoot: '/home/test/.agents/skills',
      operations: [
        {
          state: 'conflict-unmanaged',
          entryId: 'skill_12345678',
          skillName: 'demo',
          contentHash: hash,
          targetPath: '/home/test/.agents/skills/demo',
          currentHash: `sha256:${'b'.repeat(64)}`,
        },
      ],
      blocking: true,
    });
    expect(plan.operations[0]?.state).toBe('conflict-unmanaged');
  });
});
