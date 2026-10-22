import { describe, expect, it, vi } from 'vitest';
import { CANONICAL_MAIN_SCHEMA_VERSION, type CanonicalDoc, type CanonicalMainManifest } from './domain.js';
import { pullCanonicalMemory, type PullDeps } from './pull.js';

const h = (n: number) => `sha256:${n.toString().padStart(64, '0')}`;
const present = (path: string, n: number): CanonicalDoc => ({ path, state: 'present', contentHash: h(n), importedFrom: 'claude', importedAt: '2026-10-22T00:00:00.000Z' });
const manifest = (docs: CanonicalDoc[]): CanonicalMainManifest => ({ schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [{ projectId: 'prj_x', documents: docs }] });

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

  it('is up-to-date when local already equals remote exactly', async () => {
    const main = manifest([present('notes/a.md', 1)]);
    const outcome = await pullCanonicalMemory(baseDeps({
      getLocalMain: vi.fn(async () => main),
      fetchRemote: vi.fn(async () => ({ generation: 4, main })),
    }));
    expect(outcome).toEqual({ status: 'up-to-date', generation: 4 });
  });

  it('is up-to-date when Cloud has not moved since base (local differences are purely unpushed, not pulled)', async () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 2)]); // unpushed local edit
    const outcome = await pullCanonicalMemory(baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => ({ generation: 3, main: base })),
      fetchRemote: vi.fn(async () => ({ generation: 3, main: base })),
    }));
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

  it('merges a remote change on top of local-only edits with no conflict', async () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 1), present('notes/local-only.md', 9)]);
    const remote = manifest([present('notes/a.md', 2)]);
    const deps = baseDeps({
      getLocalMain: vi.fn(async () => local),
      getBase: vi.fn(async () => ({ generation: 3, main: base })),
      fetchRemote: vi.fn(async () => ({ generation: 4, main: remote })),
    });
    const outcome = await pullCanonicalMemory(deps);
    expect(outcome.status).toBe('merged-local');
    if (outcome.status === 'merged-local') {
      const paths = outcome.main.projects[0]!.documents.map((d) => d.path);
      expect(paths).toContain('notes/a.md');
      expect(paths).toContain('notes/local-only.md');
    }
    expect(deps.setBase).toHaveBeenCalledWith({ generation: 4, main: outcome.status === 'merged-local' ? outcome.main : undefined });
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
    expect(outcome).toEqual({ status: 'conflict', conflicts: [{ projectId: 'prj_x', path: 'notes/a.md', reason: 'edit-edit' }] });
    expect(deps.setLocalMain).not.toHaveBeenCalled();
    expect(deps.setBase).not.toHaveBeenCalled();
  });
});
