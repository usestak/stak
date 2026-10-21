import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { StackCompositionError } from '@stack/core';
import type { StackUseProposal } from '@stack/core';

import { registerUseCommand } from './use.js';

/** Regression: a required-Skill conflict crashed with a raw, unhandled `Error` and a Node
 *  stack trace — bin.ts's top-level catch only formats recognized error classes
 *  (`StackCompositionError` among them) cleanly, and a plain `Error` fell through it. */
describe('registerUseCommand — required Skill conflicts', () => {
  const conflictProposal: StackUseProposal = {
    stackHome: '/tmp/stak',
    current: {} as StackUseProposal['current'],
    loaded: {
      version: { name: 'frontend', requirements: [] },
    } as unknown as StackUseProposal['loaded'],
    layer: { name: 'frontend' } as StackUseProposal['layer'],
    resolved: {
      name: 'main',
      skills: [],
      skipped: [],
      conflicts: [
        {
          name: 'design-taste-frontend',
          candidates: [
            {
              contentHash: `sha256:${'a'.repeat(64)}`,
              origins: [{ type: 'direct', entryId: 'skill_12345678' }],
            },
            {
              contentHash: `sha256:${'b'.repeat(64)}`,
              origins: [
                {
                  type: 'stack',
                  layerId: 'layer_12345678',
                  stackId: 'stack_12345678',
                  stackName: 'skills-for-phatic',
                  requirementId: 'req_12345678',
                  requirement: 'required',
                },
              ],
            },
          ],
        },
      ],
      renamed: [],
    },
    summary: {
      alreadySatisfied: 0,
      newSkills: 0,
      optionalSkipped: 0,
      hardConflicts: 1,
      renamed: 0,
      directSkills: 0,
      stackLayers: 0,
      resolvedSkills: 0,
    },
  };

  const program = () => {
    const cmd = new Command();
    cmd.exitOverride();
    registerUseCommand(cmd, {
      prepareUse: async () => conflictProposal,
      applyUse: async () => {},
      confirm: async () => true,
      writeOut: () => {},
    });
    return cmd;
  };

  it('throws a StackCompositionError, not a plain Error', async () => {
    await expect(
      program().parseAsync(['node', 'stak', 'use', 'frontend']),
    ).rejects.toBeInstanceOf(StackCompositionError);
  });

  it('names the conflicting Skill and both of its sources', async () => {
    await expect(
      program().parseAsync(['node', 'stak', 'use', 'frontend']),
    ).rejects.toMatchObject({
      code: 'stack-resolution-conflict',
      message: expect.stringContaining(
        'design-taste-frontend (required differently by main and skills-for-phatic)',
      ),
    });
  });
});
