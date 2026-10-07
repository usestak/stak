import { describe, expect, it } from 'vitest';

import { createInMemoryRepository } from './memory.js';
import type { SkillReviewCheckRecord } from './repository.js';

const USER = 'user-1';
const SKILL = 'skill_test0001';
const HASH = 'sha256:' + 'a'.repeat(64);

const record = (
  over: Partial<SkillReviewCheckRecord> = {},
): SkillReviewCheckRecord => ({
  userId: USER,
  skillId: SKILL,
  approvedContentHash: HASH,
  sourceCheckState: 'update-available',
  checkedAt: new Date().toISOString(),
  candidateRevision: 'abc123',
  candidateContentHash: 'sha256:' + 'b'.repeat(64),
  reviewArtifactId: '00000000-0000-4000-8000-000000000001',
  artifactPayloadHash: 'sha256:' + 'c'.repeat(64),
  diffFiles: [],
  ...over,
});

describe('in-memory CloudRepository: skill review checks', () => {
  it('returns null when no check has ever been stored', async () => {
    const repo = createInMemoryRepository();
    expect(await repo.getSkillReviewCheck(USER, SKILL)).toBeNull();
  });
  it('stores and retrieves a check', async () => {
    const repo = createInMemoryRepository();
    const rec = record();
    await repo.putSkillReviewCheck(rec);
    expect(await repo.getSkillReviewCheck(USER, SKILL)).toEqual(rec);
  });
  it('a newer put REPLACES the prior check (latest-only)', async () => {
    const repo = createInMemoryRepository();
    await repo.putSkillReviewCheck(record({ candidateRevision: 'old' }));
    await repo.putSkillReviewCheck(record({ candidateRevision: 'new' }));
    const stored = await repo.getSkillReviewCheck(USER, SKILL);
    expect(stored?.candidateRevision).toBe('new');
  });
  it('delete removes the check', async () => {
    const repo = createInMemoryRepository();
    await repo.putSkillReviewCheck(record());
    await repo.deleteSkillReviewCheck(USER, SKILL);
    expect(await repo.getSkillReviewCheck(USER, SKILL)).toBeNull();
  });
  it('scopes by both userId and skillId — another user/skill is unaffected', async () => {
    const repo = createInMemoryRepository();
    await repo.putSkillReviewCheck(record());
    expect(await repo.getSkillReviewCheck('other-user', SKILL)).toBeNull();
    expect(await repo.getSkillReviewCheck(USER, 'skill_other0001')).toBeNull();
  });
});
