import { describe, expect, it } from 'vitest';

import {
  approveSkillVersionRequestSchema,
  reviewArtifactFileSchema,
  skillReviewArtifactSchema,
  skillSummarySchema,
  sourceCheckStateSchema,
  uploadSkillReviewArtifactRequestSchema,
} from './product.js';

const HASH = 'sha256:' + 'a'.repeat(64);
const HASH2 = 'sha256:' + 'b'.repeat(64);

describe('sourceCheckStateSchema', () => {
  it('accepts exactly the five frozen states', () => {
    for (const s of ['no-update', 'update-available', 'not-checked', 'cannot-check', 'check-failed'])
      expect(sourceCheckStateSchema.parse(s)).toBe(s);
  });
  it('rejects an invented state', () => {
    expect(sourceCheckStateSchema.safeParse('ready').success).toBe(false);
  });
});

describe('approveSkillVersionRequestSchema', () => {
  it('accepts only skillId + reviewArtifactId, never candidate fields', () => {
    const parsed = approveSkillVersionRequestSchema.parse({
      skillId: 'skill_test0001',
      reviewArtifactId: '00000000-0000-4000-8000-000000000001',
    });
    expect(parsed).toEqual({
      skillId: 'skill_test0001',
      reviewArtifactId: '00000000-0000-4000-8000-000000000001',
    });
  });
  it('rejects a browser-supplied candidateContentHash (strict schema)', () => {
    const result = approveSkillVersionRequestSchema.safeParse({
      skillId: 'skill_test0001',
      reviewArtifactId: '00000000-0000-4000-8000-000000000001',
      candidateContentHash: HASH,
    });
    expect(result.success).toBe(false);
  });
});

describe('reviewArtifactFileSchema', () => {
  it('accepts a modified text file with before/after content', () => {
    const parsed = reviewArtifactFileSchema.parse({
      relativePath: 'SKILL.md',
      kind: 'modified',
      binary: false,
      before: { byteSize: 10, hash: HASH },
      after: { byteSize: 12, hash: HASH2 },
      beforeText: 'old',
      afterText: 'new',
    });
    expect(parsed.kind).toBe('modified');
  });
  it('accepts a binary file with no text content', () => {
    const parsed = reviewArtifactFileSchema.parse({
      relativePath: 'assets/logo.png',
      kind: 'modified',
      binary: true,
      before: { byteSize: 100, hash: HASH },
      after: { byteSize: 200, hash: HASH2 },
    });
    expect(parsed.beforeText).toBeUndefined();
    expect(parsed.afterText).toBeUndefined();
  });
});

describe('skillReviewArtifactSchema', () => {
  it('parses a complete artifact', () => {
    const parsed = skillReviewArtifactSchema.parse({
      reviewArtifactId: '00000000-0000-4000-8000-000000000001',
      skillId: 'skill_test0001',
      approvedContentHash: HASH,
      candidateRevision: 'abc123',
      candidateContentHash: HASH2,
      artifactPayloadHash: 'sha256:' + 'c'.repeat(64),
      checkedAt: new Date().toISOString(),
      files: [],
    });
    expect(parsed.skillId).toBe('skill_test0001');
  });
});

describe('uploadSkillReviewArtifactRequestSchema', () => {
  it('bounds files to 200 entries', () => {
    const files = Array.from({ length: 201 }, (_, i) => ({
      relativePath: `f${i}.txt`,
      kind: 'added' as const,
      binary: false,
      after: { byteSize: 1, hash: HASH },
      afterText: 'x',
    }));
    const result = uploadSkillReviewArtifactRequestSchema.safeParse({
      skillId: 'skill_test0001',
      approvedContentHash: HASH,
      candidateRevision: 'abc123',
      candidateContentHash: HASH2,
      artifactPayloadHash: 'sha256:' + 'c'.repeat(64),
      checkedAt: new Date().toISOString(),
      files,
    });
    expect(result.success).toBe(false);
  });
});

describe('skillSummarySchema', () => {
  it('has no updateStatus/candidateVersion fields — sourceCheckState/candidateRevision instead', () => {
    const parsed = skillSummarySchema.parse({
      skillId: 'skill_test0001',
      name: 'test',
      approvedVersion: HASH,
      paused: false,
      source: { kind: 'git', checkable: true },
      capability: { declared: false },
      sourceCheckState: 'not-checked',
      checkedAt: null,
      installs: [],
    });
    expect(parsed.sourceCheckState).toBe('not-checked');
    expect('updateStatus' in parsed).toBe(false);
  });
});
