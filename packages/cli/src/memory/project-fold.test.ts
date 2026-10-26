import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  adoptReconciledProjectId,
  canonicalDigest,
  canonicalMainManifestSchema,
  encodeClaudeProjectKey,
  fileLocalMemoryKeyStore,
  hashBytes,
  InMemoryRemoteMemoryStore,
  inMemoryRemoteMemoryBackend,
  keepBothPath,
  mintProjectId,
  parseBundle,
  readCanonicalBase,
  readCanonicalMain,
  readLocalRegistry,
  readProjection,
  recordFor,
  writeLocalRegistry,
  type BackupResult,
  type CanonicalMainManifest,
  type RemoteMemoryBackend,
} from '@stack/memory';

import { projectFoldNotes } from '../ui/cloud.js';
import {
  canonicalMemoryStatus,
  pullMemoryViaCanonical,
  pushMemoryViaCanonical,
  stageAllMemory,
} from './canonical-ops.js';
import { runMemoryCloudBackup, runMemoryCloudRecover } from './cloud-ops.js';
import { applyCheckinReconciliation } from './project-fold.js';

/**
 * Spec §4.2.1, "When two Project IDs turn out to be the same project" — the
 * two-machine bug found in a real test: machine B adopted Cloud's Project ID
 * for a repository in the registry only, its next `stak add .` imported the
 * same files under the new ID, and the project split in two ("not available
 * on this machine" on both sides; B's new file never reached A).
 */

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'stak-project-fold-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const gitRemote = 'https://github.com/example/fold-demo.git';

const fakeBackup = (): Promise<BackupResult> =>
  Promise.resolve({ provider: 'claude', files: 0, projects: 0, createdAt: '2026-10-26T00:00:00.000Z' });

type Machine = {
  name: string;
  stackHome: string;
  claudeHome: string;
  projectDir: string;
  memoryDir: string;
  discovery: { claudeHome: string; projects: { dir: string; gitRemote: string }[] };
  deps: (backend: RemoteMemoryBackend) => {
    stackHome: string;
    backend: RemoteMemoryBackend;
    localKeyStore: ReturnType<typeof fileLocalMemoryKeyStore>;
    runLocalBackup: () => Promise<BackupResult>;
  };
  /** Every native agent file this machine has seen so far — none may vanish. */
  seen: Set<string>;
};

const machine = async (name: string): Promise<Machine> => {
  const stackHome = path.join(root, name, 'stack');
  const claudeHome = path.join(root, name, '.claude');
  const projectDir = path.join(root, name, 'work', 'fold-demo');
  await mkdir(projectDir, { recursive: true });
  const memoryDir = path.join(claudeHome, 'projects', encodeClaudeProjectKey(path.resolve(projectDir)), 'memory');
  const keys = fileLocalMemoryKeyStore(path.join(root, name, 'keys'), {
    harden: () => Promise.resolve(true),
    verify: () => Promise.resolve(true),
  });
  return {
    name,
    stackHome,
    claudeHome,
    projectDir,
    memoryDir,
    discovery: { claudeHome, projects: [{ dir: projectDir, gitRemote }] },
    deps: (backend) => ({ stackHome, backend, localKeyStore: keys, runLocalBackup: fakeBackup }),
    seen: new Set(),
  };
};

const writeNative = async (m: Machine, name: string, body: string) => {
  await mkdir(m.memoryDir, { recursive: true });
  await writeFile(path.join(m.memoryDir, name), body, 'utf8');
};

/** Native auto-memory files, name -> content. */
const nativeFiles = async (m: Machine): Promise<Record<string, string>> => {
  let names: string[];
  try {
    names = await readdir(m.memoryDir);
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const name of names.sort()) out[name] = await readFile(path.join(m.memoryDir, name), 'utf8');
  return out;
};

/** Spec §4.2.1: "Agent files are never deleted or rewritten by a fold" — and
 * nothing in these flows deletes one. Asserts every native file seen so far
 * still exists, then records the current set. */
const expectNoNativeDelete = async (m: Machine) => {
  const now = Object.keys(await nativeFiles(m));
  for (const name of m.seen) expect(now, `${m.name} lost native ${name}`).toContain(name);
  for (const name of now) m.seen.add(name);
};

/** Cloud's latest `main.json` exactly as uploaded (never folded on read). */
const cloudMain = async (backend: RemoteMemoryBackend): Promise<CanonicalMainManifest> => {
  const latest = await backend.getLatest();
  if (!latest) throw new Error('expected a Cloud generation');
  const bundle = parseBundle(await backend.getPayload(latest.backupId));
  return canonicalMainManifestSchema.parse(JSON.parse(Buffer.from(bundle.canonicalB64!, 'base64').toString('utf8')));
};

const projectIds = (main: CanonicalMainManifest) => main.projects.map((p) => p.projectId).sort();

/** A pushes its repo's Memory under X; fresh B pulls it; B's check-in then
 * gets Cloud's reconciliation X -> Y. Returns everything at that point. */
const reproduceUpToReconciliation = async (tag: string) => {
  const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), `fold-${tag}`);
  const A = await machine('a');
  const B = await machine('b');

  // 1. A: `stak add .` mints X; `stak push`.
  await writeNative(A, 'MEMORY.md', '# index from A\n');
  await writeNative(A, 'auth.md', 'auth notes from A');
  const stagedA = await stageAllMemory({ stackHome: A.stackHome, ...A.discovery });
  expect(stagedA.canonical.projects).toHaveLength(1);
  const X = stagedA.canonical.projects[0]!.projectId;
  expect((await pushMemoryViaCanonical(A.deps(backend), A.discovery)).status).toBe('pushed');
  await expectNoNativeDelete(A);

  // 2. Fresh B: `stak pull` (full recover, then the canonical pull).
  expect((await runMemoryCloudRecover(B.deps(backend))).status).toBe('recovered');
  const pullB = await pullMemoryViaCanonical(B.deps(backend), B.discovery);
  expect(pullB.unavailable ?? []).toEqual([]);
  expect(pullB.conflicts ?? []).toEqual([]);
  expect(await nativeFiles(B)).toEqual({ 'MEMORY.md': '# index from A\n', 'auth.md': 'auth notes from A' });
  expect(recordFor(await readLocalRegistry(B.stackHome), X)).toBeDefined();
  await expectNoNativeDelete(B);

  // 3-4. B's post-command check-in: Cloud already knew the repo as Y.
  const Y = mintProjectId();
  const folded = await applyCheckinReconciliation(B.stackHome, [{ fromProjectId: X, toProjectId: Y }]);
  expect(folded.merged).toEqual([{ fromProjectId: X, toProjectId: Y, keptBoth: 0 }]);
  expect(projectIds(await readCanonicalMain(B.stackHome))).toEqual([Y]);
  expect(projectIds((await readCanonicalBase(B.stackHome))!.main)).toEqual([Y]);
  expect(Object.keys((await readProjection(B.stackHome, 'claude')).projects)).toEqual([Y]);
  expect(recordFor(await readLocalRegistry(B.stackHome), Y)?.formerIds).toEqual([X]);
  await expectNoNativeDelete(B);

  // 5. B edits a file, adds a new one, `stak add .`, `stak push`.
  await writeNative(B, 'auth.md', 'auth notes, edited on B');
  await writeNative(B, 'deploy.md', 'deploy notes from B');
  const stagedB = await stageAllMemory({ stackHome: B.stackHome, ...B.discovery });
  expect(stagedB.canonical.projects.map((p) => p.projectId)).toEqual([Y]);
  expect(stagedB.canonical.projects[0]!.imported.sort()).toEqual(['notes/auth.md', 'notes/deploy.md']);
  expect(projectIds(await readCanonicalMain(B.stackHome))).toEqual([Y]);
  const pushB = await pushMemoryViaCanonical(B.deps(backend), B.discovery);
  expect(pushB.status).toBe('pushed');
  expect(pushB.unavailable ?? []).toEqual([]);
  expect(pushB.conflicts ?? []).toEqual([]);
  expect(projectIds(await cloudMain(backend))).toEqual([Y]);
  await expectNoNativeDelete(B);

  return { backend, A, B, X, Y };
};

/** A's `stak pull` after B pushed, then the shared end-state assertions. */
const expectAEndsFolded = async (
  ctx: Awaited<ReturnType<typeof reproduceUpToReconciliation>>,
  pullA: Awaited<ReturnType<typeof pullMemoryViaCanonical>>,
) => {
  const { backend, A, B, X, Y } = ctx;
  expect(pullA.status).toBe('merged');
  expect(pullA.unavailable ?? []).toEqual([]);
  expect(pullA.conflicts ?? []).toEqual([]);
  // A receives B's edit and B's new file; nothing on A was deleted.
  expect(await nativeFiles(A)).toEqual({
    'MEMORY.md': '# index from A\n',
    'auth.md': 'auth notes, edited on B',
    'deploy.md': 'deploy notes from B',
  });
  await expectNoNativeDelete(A);

  // Exactly one project, Y, in Cloud and on both machines; X holds nothing.
  for (const m of [A, B]) {
    expect(projectIds(await readCanonicalMain(m.stackHome))).toEqual([Y]);
    expect(Object.keys((await readProjection(m.stackHome, 'claude')).projects)).toEqual([Y]);
    const registry = await readLocalRegistry(m.stackHome);
    expect(recordFor(registry, X)).toBeUndefined();
    expect(recordFor(registry, Y)?.formerIds).toEqual([X]);
  }
  expect(projectIds(await cloudMain(backend))).toEqual([Y]);
  expect(canonicalDigest(await readCanonicalMain(A.stackHome))).toBe(canonicalDigest(await readCanonicalMain(B.stackHome)));

  // A's next `stak add .` stays on Y (no split), and its push is a no-op.
  const generation = (await backend.getLatest())!.generation;
  const stagedA = await stageAllMemory({ stackHome: A.stackHome, ...A.discovery });
  expect(stagedA.canonical.projects.map((p) => ({ id: p.projectId, imported: p.imported }))).toEqual([
    { id: Y, imported: [] },
  ]);
  const pushA = await pushMemoryViaCanonical(A.deps(backend), A.discovery);
  expect(pushA.status).toBe('up-to-date');
  expect(pushA.unavailable ?? []).toEqual([]);
  expect((await backend.getLatest())!.generation).toBe(generation);
  await expectNoNativeDelete(A);

  // And B pulls back cleanly too.
  const pullB = await pullMemoryViaCanonical(B.deps(backend), B.discovery);
  expect(pullB.unavailable ?? []).toEqual([]);
  expect(pullB.conflicts ?? []).toEqual([]);
  await expectNoNativeDelete(B);
};

describe('the fold line (spec §4.2.1)', () => {
  it('reads like the spec example', () => {
    expect(
      projectFoldNotes([
        { fromProjectId: 'prj_rvznx000000000000000000000', toProjectId: 'prj_4f6800000000000000000000', keptBoth: 1 },
        { fromProjectId: 'prj_aaaaaa00000000000000000000', toProjectId: 'prj_bbbbbb00000000000000000000', keptBoth: 0 },
      ]),
    ).toEqual([
      'Merged project prj_rvznx0… into prj_4f6800… (same repository); 1 file kept both',
      'Merged project prj_aaaaaa… into prj_bbbbbb… (same repository)',
    ]);
  });
});

describe('`stak status` folds in memory only (spec §4.2.1)', () => {
  it('a registry that already adopted the surviving ID plans against folded Memory and writes nothing', async () => {
    const A = await machine('a');
    await writeNative(A, 'MEMORY.md', 'index');
    const X = (await stageAllMemory({ stackHome: A.stackHome, ...A.discovery })).canonical.projects[0]!.projectId;
    // Registry-only adoption (e.g. a check-in whose fold was interrupted).
    const Y = mintProjectId();
    await writeLocalRegistry(A.stackHome, adoptReconciledProjectId(await readLocalRegistry(A.stackHome), X, Y));
    const mainBefore = await readFile(path.join(A.stackHome, 'memory', 'canonical', 'main.json'), 'utf8');
    const projectionBefore = await readFile(path.join(A.stackHome, 'memory', 'projections', 'claude.json'), 'utf8');

    const status = await canonicalMemoryStatus(A.stackHome, A.discovery);
    expect(status.projects.map((p) => ({ id: p.projectId, pending: p.pending, conflicts: p.conflicts }))).toEqual([
      { id: Y, pending: 0, conflicts: [] },
    ]);
    expect(await readFile(path.join(A.stackHome, 'memory', 'canonical', 'main.json'), 'utf8')).toBe(mainBefore);
    expect(await readFile(path.join(A.stackHome, 'memory', 'projections', 'claude.json'), 'utf8')).toBe(projectionBefore);

    // The next `stak add .` folds for real and imports nothing.
    const staged = await stageAllMemory({ stackHome: A.stackHome, ...A.discovery });
    expect(staged.canonical.folded).toEqual([{ fromProjectId: X, toProjectId: Y, keptBoth: 0 }]);
    expect(staged.canonical.projects.map((p) => ({ id: p.projectId, imported: p.imported }))).toEqual([
      { id: Y, imported: [] },
    ]);
    expect(projectIds(await readCanonicalMain(A.stackHome))).toEqual([Y]);
  });
});

describe('two Project IDs for the same repository (spec §4.2.1)', () => {
  it("B's reconciliation folds B's Memory; A's own check-in then reconciles too; one project everywhere", async () => {
    const ctx = await reproduceUpToReconciliation('both-reconcile');
    const folded = await applyCheckinReconciliation(ctx.A.stackHome, [
      { fromProjectId: ctx.X, toProjectId: ctx.Y },
    ]);
    expect(folded.merged).toEqual([{ fromProjectId: ctx.X, toProjectId: ctx.Y, keptBoth: 0 }]);
    await expectNoNativeDelete(ctx.A);
    const pull = await pullMemoryViaCanonical(ctx.A.deps(ctx.backend), ctx.A.discovery);
    expect(pull.folded ?? []).toEqual([]); // already folded by its own check-in
    await expectAEndsFolded(ctx, pull);
  });

  it('a machine that never got the reconciliation learns it from the snapshot when it pulls, and ends folded', async () => {
    const ctx = await reproduceUpToReconciliation('learn-from-snapshot');
    // A never ran a check-in that reconciled X -> Y.
    expect(recordFor(await readLocalRegistry(ctx.A.stackHome), ctx.X)).toBeDefined();
    const pull = await pullMemoryViaCanonical(ctx.A.deps(ctx.backend), ctx.A.discovery);
    expect(pull.folded).toEqual([{ fromProjectId: ctx.X, toProjectId: ctx.Y, keptBoth: 0 }]);
    await expectAEndsFolded(ctx, pull);
  });

  it('a machine that never learned the alias can still push first: no deletion, no false conflict', async () => {
    const ctx = await reproduceUpToReconciliation('push-first');
    // A edits something unrelated and pushes before ever pulling.
    await writeNative(ctx.A, 'style.md', 'style notes from A');
    await stageAllMemory({ stackHome: ctx.A.stackHome, ...ctx.A.discovery });
    const pushA = await pushMemoryViaCanonical(ctx.A.deps(ctx.backend), ctx.A.discovery);
    expect(pushA.status).toBe('pushed');
    expect(pushA.unavailable ?? []).toEqual([]);
    expect(pushA.conflicts ?? []).toEqual([]);
    expect(projectIds(await cloudMain(ctx.backend))).toEqual([ctx.Y]);
    expect(await nativeFiles(ctx.A)).toEqual({
      'MEMORY.md': '# index from A\n',
      'auth.md': 'auth notes, edited on B',
      'deploy.md': 'deploy notes from B',
      'style.md': 'style notes from A',
    });
    await expectNoNativeDelete(ctx.A);
    const pullB = await pullMemoryViaCanonical(ctx.B.deps(ctx.backend), ctx.B.discovery);
    expect(pullB.conflicts ?? []).toEqual([]);
    expect((await nativeFiles(ctx.B))['style.md']).toBe('style notes from A');
    await expectNoNativeDelete(ctx.B);
  });

  it('`stak memory backup` on a machine that never learned the alias folds first, like push', async () => {
    const ctx = await reproduceUpToReconciliation('backup');
    const outcome = await runMemoryCloudBackup(ctx.A.deps(ctx.backend));
    expect(outcome.cloud.status).toBe('up-to-date');
    expect('folded' in outcome.cloud ? outcome.cloud.folded : undefined).toEqual([
      { fromProjectId: ctx.X, toProjectId: ctx.Y, keptBoth: 0 },
    ]);
    expect(projectIds(await readCanonicalMain(ctx.A.stackHome))).toEqual([ctx.Y]);
    expect(projectIds(await cloudMain(ctx.backend))).toEqual([ctx.Y]);
    await expectNoNativeDelete(ctx.A);
  });

  it('both IDs hold different content at the same path: keep both, identically on every machine', async () => {
    const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), 'fold-keep-both');
    const A = await machine('a');
    const C = await machine('c');

    // A pushes the repo under S (the ID Cloud will keep).
    await writeNative(A, 'MEMORY.md', 'index from A');
    const S = (await stageAllMemory({ stackHome: A.stackHome, ...A.discovery })).canonical.projects[0]!.projectId;
    expect((await pushMemoryViaCanonical(A.deps(backend), A.discovery)).status).toBe('pushed');
    await expectNoNativeDelete(A);

    // C independently minted F for the same repo before syncing, with a
    // different MEMORY.md, and pushes: Cloud now holds both IDs.
    await writeNative(C, 'MEMORY.md', 'index from C');
    await writeNative(C, 'c-only.md', 'only on C');
    const F = (await stageAllMemory({ stackHome: C.stackHome, ...C.discovery })).canonical.projects[0]!.projectId;
    expect(F).not.toBe(S);
    expect((await pushMemoryViaCanonical(C.deps(backend), C.discovery)).status).toBe('pushed');
    expect(projectIds(await cloudMain(backend))).toEqual([F, S].sort());
    await expectNoNativeDelete(C);

    // C's check-in: Cloud already knew the repo as S.
    const folded = await applyCheckinReconciliation(C.stackHome, [{ fromProjectId: F, toProjectId: S }]);
    expect(folded.merged).toEqual([{ fromProjectId: F, toProjectId: S, keptBoth: 1 }]);
    const keptAt = keepBothPath('notes/MEMORY.md', hashBytes(Buffer.from('index from C', 'utf8')), () => false);
    const mainC = await readCanonicalMain(C.stackHome);
    expect(projectIds(mainC)).toEqual([S]);
    expect(mainC.projects[0]!.documents.map((d) => d.path)).toEqual(['notes/MEMORY.md', keptAt, 'notes/c-only.md'].sort());
    await expectNoNativeDelete(C);

    // C's next push compares FOLDED content: Cloud's version folds to exactly
    // what C has, so no duplicate generation is created.
    const generation = (await backend.getLatest())!.generation;
    const noop = await pushMemoryViaCanonical(C.deps(backend), C.discovery);
    expect(noop.status).toBe('up-to-date');
    expect(noop.conflicts ?? []).toEqual([]);
    expect((await backend.getLatest())!.generation).toBe(generation);

    // C's next real change publishes the folded project (and the alias, in
    // the snapshot); A pulls and learns the alias from it.
    await writeNative(C, 'later.md', 'a later note from C');
    await stageAllMemory({ stackHome: C.stackHome, ...C.discovery });
    const pushC = await pushMemoryViaCanonical(C.deps(backend), C.discovery);
    expect(pushC.status).toBe('pushed');
    expect(pushC.conflicts ?? []).toEqual([]);
    expect(projectIds(await cloudMain(backend))).toEqual([S]);
    const pullA = await pullMemoryViaCanonical(A.deps(backend), A.discovery);
    expect(pullA.conflicts ?? []).toEqual([]);
    expect(pullA.unavailable ?? []).toEqual([]);
    await expectNoNativeDelete(A);
    await expectNoNativeDelete(C);

    // Identical results everywhere: S's version at the path, F's kept both.
    const expected = {
      'MEMORY.md': 'index from A',
      [path.posix.basename(keptAt)]: 'index from C',
      'c-only.md': 'only on C',
      'later.md': 'a later note from C',
    };
    expect(await nativeFiles(A)).toEqual(expected);
    expect(await nativeFiles(C)).toEqual(expected);
    expect(canonicalDigest(await readCanonicalMain(A.stackHome))).toBe(canonicalDigest(await readCanonicalMain(C.stackHome)));
    expect(canonicalDigest(await readCanonicalMain(A.stackHome))).toBe(canonicalDigest(await cloudMain(backend)));
  });
});
