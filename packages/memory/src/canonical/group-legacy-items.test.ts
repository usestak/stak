import { describe, expect, it } from 'vitest';
import type { ManifestItem } from '../domain.js';
import { groupLegacyItems } from './group-legacy-items.js';

const h = (n: number) => `sha256:${n.toString().padStart(64, '0')}`;
const item = (
  projectId: string,
  relativePath: string,
  contentHash: string,
  capturedAt: string,
): ManifestItem & { __projectId: string } => ({
  __projectId: projectId,
  provider: 'claude',
  kind: 'auto-memory',
  scope: 'project',
  logicalId: `claude/auto-memory/${projectId}/${relativePath}`,
  project: { kind: 'local', vendorKey: projectId },
  contentHash,
  restoreTarget: { base: 'claude-project-memory', relativePath },
  capturedAt,
  sensitivity: 'private',
});

describe('groupLegacyItems', () => {
  it('collapses identical duplicates into one document', () => {
    const result = groupLegacyItems([
      item('prj_x', 'a.md', h(1), '2026-10-19T00:00:00.000Z'),
      item('prj_x', 'a.md', h(1), '2026-10-20T00:00:00.000Z'),
    ]);
    expect(result.keptBothDuplicates).toBe(0);
    expect(result.main.projects[0]?.documents).toHaveLength(1);
  });

  it('keeps differing duplicates under both deterministic paths, newest keeps the original', () => {
    const result = groupLegacyItems([
      item('prj_x', 'a.md', h(1), '2026-10-19T00:00:00.000Z'),
      item('prj_x', 'a.md', h(2), '2026-10-20T00:00:00.000Z'),
    ]);
    expect(result.keptBothDuplicates).toBe(1);
    const documents = result.main.projects[0]?.documents ?? [];
    const original = documents.find((d) => d.path === 'notes/a.md');
    expect(original).toMatchObject({ contentHash: h(2) });
    expect(documents.some((d) => d.path.startsWith('notes/a.conflict-'))).toBe(true);
  });
});
