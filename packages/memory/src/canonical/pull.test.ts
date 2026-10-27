import { describe, expect, it, vi } from 'vitest';
import {
  CANONICAL_MAIN_SCHEMA_VERSION,
  type CanonicalDoc,
  type CanonicalMainManifest,
} from './domain.js';
import { pullCanonicalMemory, type PullDeps } from './pull.js';
import { defined } from '../test-support.js';

const h = (n: number) => `sha256:${n.toString().padStart(64, '0')}`;
const present = (path: string, n: number): CanonicalDoc => ({
  path,
  state: 'present',
  contentHash: h(n),
  importedFrom: 'claude',
  importedAt: '2026-10-22T00:00:00.000Z',
});
const manifest = (docs: CanonicalDoc[]): CanonicalMainManifest => ({
  schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
  projects: [{ projectId: 'prj_x', documents: docs }],
});

const baseDeps = (overrides: Partial<PullDeps> = {}): PullDeps => ({
  getLocalMain: vi.fn(async () => manifest([])),
  getBase: vi.fn(async () => null),
  setLocalMain: vi.fn(async () => undefined),
  setBase: vi.fn(async () => undefined),
  fetchRemote: vi.fn(async () => null),
  savePendingMerge: vi.fn(async () => undefined),
  clearPendingMerge: vi.fn(async () => undefined),
  ...overrides,
});

describe('pullCanonicalMemory', () => {
  it('is up-to-date when there is nothing on Cloud yet', async () => {
    const outcome = await pullCanonicalMemory(baseDeps());
    expect(outcome).toEqual({ status: 'up-to-date', generation: null });
  });

  it('is up-to-date when local already equals remote exactly, and repairs a missing base', async () => {
    const main = manifest([present('notes/a.md', 1)]);
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => main),
      fetchRemote: vi.fn(async () => ({ generation: 4, main })),
      // base is null (the default) — e.g. a fresh machine whose local Memory
      // already happens to match Cloud, or a crash right after an earlier
      // sync's local writes. Must be repaired so a LATER pull/push doesn't
      // merge against a base that doesn't reflect reality.
    });
    const outcome = await pullCanonicalMemory(deps);
    expect(outcome).toEqual({ status: 'up-to-date', generation: 4 });
    expect(deps.setBase).toHaveBeenCalledWith({ generation: 4, main });
  });

  it('is up-to-date when Cloud has not moved since base (local differences are purely unpushed, not pulled)', async () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 2)]); // unpushed local edit
    const outcome = await pullCanonicalMemory(
      baseDeps({
        getLocalMain: vi.fn(async () => local),
        getBase: vi.fn(async () => ({ generation: 3, main: base })),
        fetchRemote: vi.fn(async () => ({ generation: 3, main: base })),
      }),
    );
    expect(outcome).toEqual({ status: 'up-to-date', generation: 3 });
  });

  it('merges a one-sided remote-only change on a fresh machine (no base, empty local) and advances base', async () => {
    const remote = manifest([present('notes/a.md', 1)]);
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => manifest([])),
      getBase: vi.fn(async () => null),
      fetchRemote: vi.fn(async () => ({ generation: 0, main: remote })),
    });
    const outcome = await pullCanonicalMemory(deps);
    expect(outcome).toEqual({ status: 'merged-local', main: remote });
    expect(deps.setLocalMain).toHaveBeenCalledWith(remote);
    expect(deps.setBase).toHaveBeenCalledWith({ generation: 0, main: remote });
  });

  it('merges a remote change on top of local-only edits with no conflict, basing on what Cloud ACTUALLY holds, not the merge result', async () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([
      present('notes/a.md', 1),
      present('notes/local-only.md', 9),
    ]); // unpushed local-only doc
    const remote = manifest([present('notes/a.md', 2)]);
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => ({ generation: 3, main: base })),
      fetchRemote: vi.fn(async () => ({ generation: 4, main: remote })),
    });
    const outcome = await pullCanonicalMemory(deps);
    expect(outcome.status).toBe('merged-local');
    if (outcome.status === 'merged-local') {
      // Local storage DOES get the merge (including the still-unpushed local-only doc).
      const paths = defined(outcome.main.projects[0]).documents.map(
        (d) => d.path,
      );
      expect(paths).toContain('notes/a.md');
      expect(paths).toContain('notes/local-only.md');
    }
    // The BASE must record what Cloud generation 4 actually holds (just `remote`,
    // no local-only.md) — never the merge result. If the base recorded the merge
    // result instead, a later pull against a newer remote that also lacks
    // local-only.md would read it as "Cloud deleted my unpushed document" and
    // silently drop it from local storage, even though it was never pushed and
    // nothing ever deleted it.
    expect(deps.setBase).toHaveBeenCalledWith({ generation: 4, main: remote });
  });

  it('a later pull against a newer remote never loses a still-unpushed local-only document (regression for the base-content bug above)', async () => {
    const base1 = manifest([present('notes/a.md', 1)]);
    const localWithUnpushedDoc = manifest([
      present('notes/a.md', 1),
      present('notes/local-only.md', 9),
    ]);
    const remote1 = manifest([present('notes/a.md', 2)]);
    let storedLocal = localWithUnpushedDoc;
    let storedBase: { generation: number; main: CanonicalMainManifest } | null =
      { generation: 3, main: base1 };
    const deps: PullDeps = {
      getLocalMain: vi.fn(async () => storedLocal),
      getBase: vi.fn(async () => storedBase),
      setLocalMain: vi.fn(async (main) => {
        storedLocal = main;
      }),
      setBase: vi.fn(async (base) => {
        storedBase = base;
      }),
      fetchRemote: vi.fn(async () => ({ generation: 4, main: remote1 })),
      savePendingMerge: vi.fn(async () => undefined),
      clearPendingMerge: vi.fn(async () => undefined),
    };
    await pullCanonicalMemory(deps); // first pull: merges, base correctly becomes {4, remote1}

    // A second machine now publishes generation 5 — still without local-only.md,
    // since that document was never pushed by anyone.
    const remote2 = manifest([
      present('notes/a.md', 2),
      present('notes/other.md', 5),
    ]);
    deps.fetchRemote = vi.fn(async () => ({ generation: 5, main: remote2 }));
    const second = await pullCanonicalMemory(deps);
    expect(second.status).toBe('merged-local');
    if (second.status === 'merged-local') {
      const paths = defined(second.main.projects[0]).documents.map(
        (d) => d.path,
      );
      expect(paths).toContain('notes/local-only.md'); // still there — never pushed, never deleted
      expect(paths).toContain('notes/other.md');
    }
  });

  it('stops with status conflict and saves a pending merge, without touching local main or base', async () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 2)]);
    const remote = manifest([present('notes/a.md', 3)]);
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => ({ generation: 3, main: base })),
      fetchRemote: vi.fn(async () => ({ generation: 4, main: remote })),
    });
    const outcome = await pullCanonicalMemory(deps);
    expect(outcome).toEqual({
      status: 'conflict',
      conflicts: [
        { projectId: 'prj_x', path: 'notes/a.md', reason: 'edit-edit' },
      ],
    });
    expect(deps.setLocalMain).not.toHaveBeenCalled();
    expect(deps.setBase).not.toHaveBeenCalled();
  });
});

describe('pullCanonicalMemory: pending merge bookkeeping (Task 14 fix round 1)', () => {
  it('a conflict records the generation the merged content came from, not the commit counter', async () => {
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => manifest([present('notes/a.md', 2)])),
      getBase: vi.fn(async () => ({
        generation: 1,
        main: manifest([present('notes/a.md', 1)]),
      })),
      fetchRemote: vi.fn(async () => ({
        generation: 7,
        contentGeneration: 5,
        main: manifest([present('notes/a.md', 3)]),
      })),
    });
    expect((await pullCanonicalMemory(deps)).status).toBe('conflict');
    expect(deps.savePendingMerge).toHaveBeenCalledWith(
      expect.objectContaining({ basedOnGeneration: 5 }),
    );
  });

  it('clears a leftover merge.json on both up-to-date branches', async () => {
    const same = manifest([present('notes/a.md', 1)]);
    const equal = baseDeps({
      getLocalMain: vi.fn(async () => same),
      fetchRemote: vi.fn(async () => ({ generation: 2, main: same })),
    });
    expect((await pullCanonicalMemory(equal)).status).toBe('up-to-date');
    expect(equal.clearPendingMerge).toHaveBeenCalled();
    const notMoved = baseDeps({
      getLocalMain: vi.fn(async () => manifest([present('notes/a.md', 2)])),
      getBase: vi.fn(async () => ({ generation: 2, main: same })),
      fetchRemote: vi.fn(async () => ({ generation: 2, main: same })),
    });
    expect((await pullCanonicalMemory(notMoved)).status).toBe('up-to-date');
    expect(notMoved.clearPendingMerge).toHaveBeenCalled();
  });
});

describe('pullCanonicalMemory: last-synced global digest (final review I1 re-fix)', () => {
  const m = (n: number): CanonicalMainManifest => ({
    schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
    projects: [
      {
        projectId: 'prj_x',
        documents: [
          {
            path: 'notes/a.md',
            state: 'present',
            contentHash: `sha256:${n.toString().padStart(64, '0')}`,
            importedFrom: 'claude',
            importedAt: '2026-10-22T00:00:00.000Z',
          },
        ],
      },
    ],
  });
  const run = async (
    base: {
      generation: number;
      main: CanonicalMainManifest;
      globalDigest?: string;
    } | null,
    local: string,
    cloud: string,
    localMain: CanonicalMainManifest = m(1),
  ) => {
    const setBase = vi.fn(async () => undefined);
    await pullCanonicalMemory({
      getLocalMain: async () => localMain,
      getBase: async () => base,
      setLocalMain: async () => undefined,
      setBase,
      getLocalGlobalDigest: async () => local,
      fetchRemote: async () => ({
        generation: 5,
        main: m(2),
        globalDigest: cloud,
      }),
      savePendingMerge: async () => undefined,
      clearPendingMerge: async () => undefined,
    });
    return setBase;
  };

  it('keeps the recorded digest (never swallows an unpushed local global edit)', async () => {
    const setBase = await run(
      { generation: 4, main: m(1), globalDigest: 'g-synced' },
      'g-edited-locally',
      'g-cloud',
    );
    expect(setBase).toHaveBeenCalledWith({
      generation: 5,
      main: m(2),
      globalDigest: 'g-synced',
    });
  });

  it('with no record: records only when local global equals Cloud', async () => {
    // Local canonical already equals Cloud: the base-repair branch writes the base.
    expect(await run(null, 'g', 'g', m(2))).toHaveBeenCalledWith({
      generation: 5,
      main: m(2),
      globalDigest: 'g',
    });
    expect(await run(null, 'g-mine', 'g-cloud', m(2))).toHaveBeenCalledWith({
      generation: 5,
      main: m(2),
    });
  });
});
