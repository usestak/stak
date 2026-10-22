import { describe, expect, it, vi } from 'vitest';
import { CANONICAL_MAIN_SCHEMA_VERSION, type CanonicalDoc, type CanonicalMainManifest } from './domain.js';
import { pushCanonicalMemory, type PushDeps } from './push.js';

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

const baseDeps = (overrides: Partial<PushDeps> = {}): PushDeps => ({
  getLocalMain: vi.fn(async () => manifest([present('notes/a.md', 1)])),
  getBase: vi.fn(async () => null),
  setLocalMain: vi.fn(async () => undefined),
  setBase: vi.fn(async () => undefined),
  fetchRemote: vi.fn(async () => null),
  publish: vi.fn(async () => ({ generation: 0 })),
  savePendingMerge: vi.fn(async () => undefined),
  clearPendingMerge: vi.fn(async () => undefined),
  ...overrides,
});

describe('pushCanonicalMemory', () => {
  it('fast-forwards when this is the first push (no base, no remote)', async () => {
    const deps = baseDeps();
    const outcome = await pushCanonicalMemory(deps);
    expect(outcome).toEqual({ status: 'pushed', generation: 0, main: manifest([present('notes/a.md', 1)]) });
    expect(deps.publish).toHaveBeenCalledWith(manifest([present('notes/a.md', 1)]), null);
    expect(deps.setBase).toHaveBeenCalledWith({ generation: 0, main: manifest([present('notes/a.md', 1)]) });
  });

  it('fast-forwards when base already equals the remote latest', async () => {
    const local = manifest([present('notes/a.md', 2)]);
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => ({ generation: 3, main: manifest([present('notes/a.md', 1)]) })),
      fetchRemote: vi.fn(async () => ({ generation: 3, main: manifest([present('notes/a.md', 1)]) })),
      publish: vi.fn(async (_main, expectedParent) => {
        expect(expectedParent).toBe(3);
        return { generation: 4 };
      }),
    });
    const outcome = await pushCanonicalMemory(deps);
    expect(outcome).toEqual({ status: 'pushed', generation: 4, main: local });
  });

  it('repairs base without creating a duplicate generation when Cloud already equals local (crash-after-success)', async () => {
    const local = manifest([present('notes/a.md', 2)]);
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => ({ generation: 3, main: manifest([present('notes/a.md', 1)]) })),
      fetchRemote: vi.fn(async () => ({ generation: 4, main: local })), // Cloud already has exactly `local`
      publish: vi.fn(),
    });
    const outcome = await pushCanonicalMemory(deps);
    expect(outcome).toEqual({ status: 'up-to-date', generation: 4 });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.setBase).toHaveBeenCalledWith({ generation: 4, main: local });
  });

  it('is a true no-op when base and remote generations already agree and local already matches remote (the most common push of all)', async () => {
    const same = manifest([present('notes/a.md', 1)]);
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => same),
      getBase: vi.fn(async () => ({ generation: 3, main: same })),
      fetchRemote: vi.fn(async () => ({ generation: 3, main: same })), // same generation AND same content
      publish: vi.fn(),
    });
    const outcome = await pushCanonicalMemory(deps);
    expect(outcome).toEqual({ status: 'up-to-date', generation: 3 });
    expect(deps.publish).not.toHaveBeenCalled(); // must NEVER create a duplicate generation
  });

  it('merges changes from BOTH sides with no conflict, then publishes the merge, and adopts it locally', async () => {
    // Local and remote each added a DIFFERENT document since base, so the merge
    // result genuinely differs from remote's own content — unlike a one-sided
    // remote-only change (covered by the next test), this one really does have
    // something new to upload.
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 1), present('notes/c.md', 7)]); // local added c.md
    const remote = manifest([present('notes/a.md', 1), present('notes/b.md', 9)]); // remote added b.md
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => ({ generation: 3, main: base })),
      fetchRemote: vi.fn(async () => ({ generation: 4, main: remote })),
      publish: vi.fn(async (_main, expectedParent) => {
        expect(expectedParent).toBe(4);
        return { generation: 5 };
      }),
    });
    const outcome = await pushCanonicalMemory(deps);
    expect(outcome.status).toBe('pushed');
    const merged = manifest([present('notes/a.md', 1), present('notes/c.md', 7), present('notes/b.md', 9)]);
    if (outcome.status === 'pushed') expect(outcome.main.projects[0]!.documents.length).toBe(3);
    expect(deps.setLocalMain).toHaveBeenCalledWith(expect.objectContaining({
      projects: [expect.objectContaining({ documents: expect.arrayContaining(merged.projects[0]!.documents) })],
    }));
  });

  it('a clean merge that turns out identical to remote is adopted locally but never republished', async () => {
    // Local never actually changed anything new relative to base; the merge's
    // only job here is to pick up remote's own one-sided change — the SAME
    // content Cloud's latest already holds. Publishing it again would create a
    // duplicate generation; this must be treated as up-to-date instead, while
    // still writing the merge result into local storage (local was missing
    // remote's change until now).
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 1)]); // unchanged since base
    const remote = manifest([present('notes/a.md', 1), present('notes/b.md', 9)]);
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => ({ generation: 3, main: base })),
      fetchRemote: vi.fn(async () => ({ generation: 4, main: remote })),
      publish: vi.fn(),
    });
    const outcome = await pushCanonicalMemory(deps);
    expect(outcome).toEqual({ status: 'up-to-date', generation: 4 });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.setLocalMain).toHaveBeenCalledWith(remote);
    expect(deps.setBase).toHaveBeenCalledWith({ generation: 4, main: remote });
  });

  it('stops with status conflict and saves a pending merge, without publishing', async () => {
    const local = manifest([present('notes/a.md', 2)]);
    const remote = manifest([present('notes/a.md', 3)]);
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => ({ generation: 3, main: manifest([present('notes/a.md', 1)]) })),
      fetchRemote: vi.fn(async () => ({ generation: 4, main: remote })),
      publish: vi.fn(),
    });
    const outcome = await pushCanonicalMemory(deps);
    expect(outcome).toEqual({
      status: 'conflict',
      conflicts: [{ projectId: 'prj_x', path: 'notes/a.md', reason: 'edit-edit' }],
    });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.savePendingMerge).toHaveBeenCalledWith({
      basedOnGeneration: 4,
      merged: manifest([]),
      conflicts: [{ projectId: 'prj_x', path: 'notes/a.md', reason: 'edit-edit' }],
    });
  });

  it('retries when publish reports a concurrent conflict, then succeeds against the new remote', async () => {
    // local genuinely differs from base/remote — a REAL pending change, not a
    // no-op — so the retry mechanism is exercised honestly, without also
    // triggering the unrelated "nothing to push" short-circuit.
    const local = manifest([present('notes/a.md', 2)]);
    let fetchCount = 0;
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => ({ generation: 3, main: manifest([present('notes/a.md', 1)]) })),
      fetchRemote: vi.fn(async () => {
        fetchCount += 1;
        // Cloud stays at generation 3 with the old content on both calls — the
        // conflict is purely a simulated concurrent-write race on `publish`
        // itself, not a real move of Cloud's latest.
        return { generation: 3, main: manifest([present('notes/a.md', 1)]) };
      }),
      publish: vi.fn()
        .mockRejectedValueOnce({ code: 'conflict' })
        .mockResolvedValueOnce({ generation: 4 }),
    });
    const outcome = await pushCanonicalMemory(deps);
    expect(outcome).toEqual({ status: 'pushed', generation: 4, main: local });
    expect(fetchCount).toBe(2);
    expect(deps.publish).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts concurrent conflicts', async () => {
    const local = manifest([present('notes/a.md', 2)]); // genuinely differs; see note above
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => ({ generation: 3, main: manifest([present('notes/a.md', 1)]) })),
      fetchRemote: vi.fn(async () => ({ generation: 3, main: manifest([present('notes/a.md', 1)]) })),
      publish: vi.fn(async () => {
        throw { code: 'conflict' };
      }),
      maxAttempts: 3,
    });
    const outcome = await pushCanonicalMemory(deps);
    expect(outcome).toEqual({ status: 'retry-exhausted' });
    expect(deps.publish).toHaveBeenCalledTimes(3);
  });

  it('propagates a non-conflict publish error immediately, without retrying', async () => {
    const local = manifest([present('notes/a.md', 2)]);
    const boom = new Error('network unreachable');
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => ({ generation: 3, main: manifest([present('notes/a.md', 1)]) })),
      fetchRemote: vi.fn(async () => ({ generation: 3, main: manifest([present('notes/a.md', 1)]) })),
      publish: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(pushCanonicalMemory(deps)).rejects.toBe(boom);
    expect(deps.publish).toHaveBeenCalledTimes(1); // never retried — this isn't a race, retrying would misreport the real failure
  });
});
