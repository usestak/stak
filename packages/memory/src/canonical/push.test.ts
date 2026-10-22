import { describe, expect, it, vi } from 'vitest';
import { CANONICAL_MAIN_SCHEMA_VERSION, type CanonicalDoc, type CanonicalMainManifest } from './domain.js';
import { PushError, pushCanonicalMemory, type PushDeps } from './push.js';

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

  it('merges a one-sided remote change with no conflict, then publishes the merge', async () => {
    const local = manifest([present('notes/a.md', 1)]); // unchanged locally since base
    const remote = manifest([present('notes/a.md', 1), present('notes/b.md', 9)]);
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => ({ generation: 3, main: manifest([present('notes/a.md', 1)]) })),
      fetchRemote: vi.fn(async () => ({ generation: 4, main: remote })),
      publish: vi.fn(async (_main, expectedParent) => {
        expect(expectedParent).toBe(4);
        return { generation: 5 };
      }),
    });
    const outcome = await pushCanonicalMemory(deps);
    expect(outcome.status).toBe('pushed');
    if (outcome.status === 'pushed')
      expect(outcome.main.projects[0]!.documents).toEqual(remote.projects[0]!.documents);
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
    const local = manifest([present('notes/a.md', 1)]);
    let fetchCount = 0;
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => ({ generation: 3, main: manifest([present('notes/a.md', 1)]) })),
      fetchRemote: vi.fn(async () => {
        fetchCount += 1;
        // First call: still generation 3 (no new remote state) so push attempts to
        // fast-forward and publish, which fails once with a conflict; second call
        // (after the retry) reflects the generation that publish's failure implies.
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
    const local = manifest([present('notes/a.md', 1)]);
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

  it('propagates a non-conflict publish error immediately instead of retrying or swallowing it into retry-exhausted', async () => {
    const local = manifest([present('notes/a.md', 1)]);
    const boom = new Error('network is down');
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => null),
      fetchRemote: vi.fn(async () => null),
      publish: vi.fn(async () => {
        throw boom;
      }),
      maxAttempts: 3,
    });
    await expect(pushCanonicalMemory(deps)).rejects.toBe(boom);
    expect(deps.publish).toHaveBeenCalledTimes(1);
  });

  it('exports PushError as an Error subclass carrying the retry-exhausted code', () => {
    const error = new PushError();
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('retry-exhausted');
  });
});
