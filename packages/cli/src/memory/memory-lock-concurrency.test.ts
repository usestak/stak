/**
 * Lock Task 4 (spec 2026-10-25 §5): the Memory lock serializes the real command
 * pairings that can race on one machine — add + pull, add + push, pull + push and
 * materialize + pull.
 *
 * The InMemory backend can't be shared across processes, so these run both commands
 * concurrently in ONE process, each wrapped in the real file-based `withMemoryLock`
 * exactly as `program.ts` wires it (the genuine multi-process test of the primitive
 * lives in `@stack/memory`'s memory-lock tests). Inside one process the file lock
 * behaves the same: the second acquire sees a live holder and waits.
 *
 * Interleaving is forced through the one injectable seam these functions have — the
 * Cloud backend. Pull and push both read local canonical main, then ask the backend
 * whether their sync base still exists (`getGeneration(base)`), then write main. A
 * backend that stalls on that call holds the read-to-write window open. The control
 * test stalls it until `stak add` has finished, which deterministically loses `add`'s
 * staged edit when the lock is bypassed.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  encodeClaudeProjectKey,
  fetchRemoteCanonical,
  fileLocalMemoryKeyStore,
  hashBytes,
  InMemoryRemoteMemoryStore,
  inMemoryRemoteMemoryBackend,
  leftoverClearedMessage,
  mintProjectId,
  readCanonicalBase,
  readCanonicalMain,
  readLocalRegistry,
  resolveOrMintProject,
  setBinding,
  withMemoryLock,
  writeLocalRegistry,
  type BackupResult,
  type RemoteMemoryBackend,
} from '@stack/memory';

import {
  materializeMemory,
  pullMemoryViaCanonical,
  pushMemoryViaCanonical,
  stageAllMemory,
  stageCanonicalMemory,
} from './canonical-ops.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'stak-lock-pairings-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

/* ------------------------------ fixtures ------------------------------ */
/* Same two-machine shape as canonical-ops.test.ts's Task 14 fixtures.      */

type Machine = { home: string; claude: string; dir: string; keys: string };

const machine = async (base: string, tag: string): Promise<Machine> => {
  const m = {
    home: path.join(base, `${tag}-stack`),
    claude: path.join(base, `${tag}-claude`),
    dir: path.join(base, `${tag}-proj`),
    keys: path.join(base, `${tag}-keys`),
  };
  await mkdir(m.dir, { recursive: true });
  return m;
};
const fakeBackup = (): Promise<BackupResult> =>
  Promise.resolve({ provider: 'claude', files: 0, projects: 0, createdAt: '2026-10-25T00:00:00.000Z' });
const depsOf = (m: Machine, backend: RemoteMemoryBackend) => ({
  stackHome: m.home,
  backend,
  localKeyStore: fileLocalMemoryKeyStore(m.keys, {
    harden: () => Promise.resolve(true),
    verify: () => Promise.resolve(true),
  }),
  runLocalBackup: fakeBackup,
});
const discoveryOf = (m: Machine) => ({ claudeHome: m.claude });
const bindAt = async (m: Machine, fixedProjectId?: string) => {
  const registry = await readLocalRegistry(m.home);
  const minted = resolveOrMintProject(
    registry,
    { kind: 'local', vendorKey: `v-${path.basename(m.home)}` },
    fixedProjectId ? () => fixedProjectId : mintProjectId,
  );
  await writeLocalRegistry(
    m.home,
    setBinding(minted.registry, {
      projectId: minted.projectId,
      dir: m.dir,
      boundAt: '2026-10-25T00:00:00.000Z',
      provenance: 'user-map',
    }),
  );
  return minted.projectId;
};
const nativeOf = (m: Machine, name: string) =>
  path.join(m.claude, 'projects', encodeClaudeProjectKey(path.resolve(m.dir)), 'memory', name);
const writeNative = async (m: Machine, name: string, body: string) => {
  await mkdir(path.dirname(nativeOf(m, name)), { recursive: true });
  await writeFile(nativeOf(m, name), body, 'utf8');
};
const readNative = async (m: Machine, name: string) => {
  try {
    return await readFile(nativeOf(m, name), 'utf8');
  } catch {
    return null;
  }
};
const hashOf = (body: string) => hashBytes(Buffer.from(body, 'utf8'));

/**
 * Machine Y is synced with Cloud at `notes/MEMORY.md` = "a" and `notes/keep.md` =
 * "kept". Then machine X adds `notes/new.md` = "from X" and pushes, so Cloud is one
 * generation ahead of Y's sync base.
 */
const synced = async (tag: string) => {
  const base = path.join(root, tag);
  const backend = inMemoryRemoteMemoryBackend(new InMemoryRemoteMemoryStore(), `lock-${tag}`);
  const X = await machine(base, 'x');
  const Y = await machine(base, 'y');
  const projectId = await bindAt(X);
  await bindAt(Y, projectId);
  await writeNative(X, 'keep.md', 'kept');
  await writeNative(X, 'MEMORY.md', 'a');
  await stageCanonicalMemory(X.home, discoveryOf(X));
  expect((await pushMemoryViaCanonical(depsOf(X, backend), discoveryOf(X))).status).toBe('pushed');
  expect((await pullMemoryViaCanonical(depsOf(Y, backend), discoveryOf(Y))).status).toBe('merged');
  expect(await readNative(Y, 'MEMORY.md')).toBe('a');
  await writeNative(X, 'new.md', 'from X');
  await stageCanonicalMemory(X.home, discoveryOf(X));
  expect((await pushMemoryViaCanonical(depsOf(X, backend), discoveryOf(X))).status).toBe('pushed');
  const yBase = await readCanonicalBase(Y.home);
  if (!yBase) throw new Error('test setup: Y has no sync base');
  return { backend, X, Y, projectId, yBaseGeneration: yBase.generation };
};
type Fixture = Awaited<ReturnType<typeof synced>>;

/**
 * Wrap a backend so its `getGeneration(<Y's sync base>)` — the call pull and push make
 * between reading local main and writing it — first awaits `stall()`. Only the first
 * such call stalls; everything else passes straight through.
 */
const stallingBackend = (
  backend: RemoteMemoryBackend,
  baseGeneration: number,
  stall: () => Promise<void>,
): { backend: RemoteMemoryBackend; stalled: () => boolean } => {
  let used = false;
  const wrapped = new Proxy(backend, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === 'getGeneration')
        return async (generation: number) => {
          if (!used && generation === baseGeneration) {
            used = true;
            await stall();
          }
          return target.getGeneration(generation);
        };
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { backend: wrapped, stalled: () => used };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* ------------------------------ commands ------------------------------ */
/* The exact functions program.ts wires for each command's Memory part.    */

type CommandName = 'add' | 'pull' | 'push' | 'materialize';
const commandFn = (f: Fixture, name: CommandName, backend: RemoteMemoryBackend): (() => Promise<unknown>) => {
  const { Y } = f;
  switch (name) {
    case 'add': // program.ts `stageMemory`
      return () => stageAllMemory({ stackHome: Y.home, ...discoveryOf(Y) });
    case 'pull': // program.ts `applyCanonicalPull`
      return () => pullMemoryViaCanonical(depsOf(Y, backend), discoveryOf(Y));
    case 'push': // program.ts `applyMemoryPush`
      return () => pushMemoryViaCanonical(depsOf(Y, backend), discoveryOf(Y));
    case 'materialize': // program.ts `memoryMaterialize`
      return () => materializeMemory(Y.home, discoveryOf(Y));
  }
};

/** `withMemoryLock` exactly as program.ts wires it (leftover notes captured, not printed). */
const programLock = (stackHome: string, leftovers: string[]) =>
  <T,>(command: string, fn: () => Promise<T>): Promise<T> =>
    withMemoryLock(stackHome, command, fn, {
      onLeftoverCleared: (holder) => leftovers.push(leftoverClearedMessage(holder)),
    });

/* ------------------------------ snapshots ----------------------------- */

type Snapshot = {
  local: Record<string, string>;
  cloud: Record<string, string>;
  native: Record<string, string | null>;
};
const docsOf = (main: Awaited<ReturnType<typeof readCanonicalMain>>, projectId: string) =>
  Object.fromEntries(
    (main.projects.find((p) => p.projectId === projectId)?.documents ?? [])
      .map((d) => [d.path, d.state === 'present' ? `present:${d.contentHash}` : `deleted:${d.lastContentHash}`] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
const snapshot = async (f: Fixture): Promise<Snapshot> => {
  const remote = await fetchRemoteCanonical({
    backend: f.backend,
    localRegistry: await readLocalRegistry(f.Y.home),
  });
  return {
    local: docsOf(await readCanonicalMain(f.Y.home), f.projectId),
    cloud: remote ? docsOf(remote.main, f.projectId) : {},
    native: {
      'MEMORY.md': await readNative(f.Y, 'MEMORY.md'),
      'keep.md': await readNative(f.Y, 'keep.md'),
      'new.md': await readNative(f.Y, 'new.md'),
    },
  };
};

/* ------------------------------ pairings ------------------------------ */

type Pairing = {
  name: string;
  commands: [CommandName, CommandName];
  /** Y's local changes before the race. */
  arrange(f: Fixture): Promise<void>;
  /** Documents that must survive in Y's canonical main whatever the order. */
  mustKeep: Record<string, string>;
};

const pairings: Pairing[] = [
  {
    // Cloud has a doc that pull merges in, while add stages a native edit.
    name: 'add + pull',
    commands: ['add', 'pull'],
    arrange: (f) => writeNative(f.Y, 'MEMORY.md', 'b'),
    mustKeep: { 'notes/MEMORY.md': 'b', 'notes/new.md': 'from X', 'notes/keep.md': 'kept' },
  },
  {
    // An already-staged edit is being pushed while add stages a second one.
    name: 'add + push',
    commands: ['add', 'push'],
    arrange: async (f) => {
      await writeNative(f.Y, 'keep.md', 'kept 2');
      await stageCanonicalMemory(f.Y.home, discoveryOf(f.Y));
      await writeNative(f.Y, 'MEMORY.md', 'b');
    },
    mustKeep: { 'notes/MEMORY.md': 'b', 'notes/new.md': 'from X', 'notes/keep.md': 'kept 2' },
  },
  {
    // A staged edit is pushed while pull merges Cloud's new doc.
    name: 'pull + push',
    commands: ['pull', 'push'],
    arrange: async (f) => {
      await writeNative(f.Y, 'keep.md', 'kept 2');
      await stageCanonicalMemory(f.Y.home, discoveryOf(f.Y));
    },
    mustKeep: { 'notes/MEMORY.md': 'a', 'notes/new.md': 'from X', 'notes/keep.md': 'kept 2' },
  },
  {
    // Materialize rewrites agent files while pull merges and materializes Cloud's new doc.
    name: 'materialize + pull',
    commands: ['materialize', 'pull'],
    arrange: async () => undefined,
    mustKeep: { 'notes/MEMORY.md': 'a', 'notes/new.md': 'from X', 'notes/keep.md': 'kept' },
  },
];

/** Run the two commands one after the other, unlocked, on a fresh fixture. */
const sequential = async (p: Pairing, order: [CommandName, CommandName], tag: string): Promise<Snapshot> => {
  const f = await synced(tag);
  await p.arrange(f);
  for (const name of order) await commandFn(f, name, f.backend)();
  return snapshot(f);
};

const ITERATIONS = 3;

describe('the Memory lock serializes real command pairings (spec 2026-10-25 §5)', () => {
  for (const p of pairings)
    it(`${p.name}: never overlaps, loses nothing, and ends as one of the sequential orders`, async () => {
      const [first, second] = p.commands;
      const orders = [
        await sequential(p, [first, second], `${p.commands.join('-')}-seq-ab`),
        await sequential(p, [second, first], `${p.commands.join('-')}-seq-ba`),
      ];

      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const f = await synced(`${p.commands.join('-')}-race-${iteration}`);
        await p.arrange(f);
        const leftovers: string[] = [];
        const lock = programLock(f.Y.home, leftovers);
        const events: string[] = [];
        // Hold each command's read-to-write window open, so an unserialized pair would
        // interleave inside it.
        const { backend, stalled } = stallingBackend(f.backend, f.yBaseGeneration, () => sleep(40));
        const run = (name: CommandName) => {
          events.push(`${name}:request`);
          return lock(`stak ${name}`, async () => {
            events.push(`${name}:enter`);
            try {
              await sleep(0);
              return await commandFn(f, name, backend)();
            } finally {
              events.push(`${name}:exit`);
            }
          });
        };
        // Alternate which command asks first.
        const [a, b] = iteration % 2 === 0 ? [first, second] : [second, first];
        await Promise.all([run(a), run(b)]);
        // The read-to-write window really was held open (every pairing has a pull or push).
        expect(stalled()).toBe(true);

        // Both asked before either finished (genuine contention), and the critical
        // sections never overlapped.
        expect(events.slice(0, 2).sort()).toEqual([`${a}:request`, `${b}:request`].sort());
        const sections = events.filter((e) => !e.endsWith(':request'));
        const winner = sections[0]?.split(':')[0] as CommandName;
        const loser = winner === a ? b : a;
        expect(sections).toEqual([`${winner}:enter`, `${winner}:exit`, `${loser}:enter`, `${loser}:exit`]);
        expect(leftovers).toEqual([]);

        // No document lost.
        const final = await snapshot(f);
        for (const [docPath, body] of Object.entries(p.mustKeep))
          expect(final.local[docPath], `${p.name}: ${docPath}`).toBe(`present:${hashOf(body)}`);

        // Equal to running the two commands back to back, in one order or the other.
        expect(orders).toContainEqual(final);
      }
    });
});

describe('the race is real: without the lock, the same schedule loses Memory', () => {
  it('without the lock, add + pull can lose a document (here: the staged edit)', async () => {
    const f = await synced('control');
    await writeNative(f.Y, 'MEMORY.md', 'b');
    // Pull stalls between reading local main and writing it until add has finished:
    // pull then writes a merge computed from the main it read BEFORE add staged "b".
    let addDone!: () => void;
    const addFinished = new Promise<void>((resolve) => {
      addDone = resolve;
    });
    const { backend, stalled } = stallingBackend(f.backend, f.yBaseGeneration, () => addFinished);
    const pull = commandFn(f, 'pull', backend)();
    const add = (async () => {
      await sleep(20); // let pull read local main first
      try {
        return await commandFn(f, 'add', f.backend)();
      } finally {
        addDone();
      }
    })();
    await Promise.all([pull, add]);
    expect(stalled()).toBe(true);

    const final = await snapshot(f);
    // Pull's merge landed (new.md is there) ...
    expect(final.local['notes/new.md']).toBe(`present:${hashOf('from X')}`);
    // ... but add's staged edit is gone from canonical main: the loss the lock prevents.
    expect(final.local['notes/MEMORY.md']).not.toBe(`present:${hashOf('b')}`);
  });

  it('with the lock, the identical schedule keeps both', async () => {
    const f = await synced('control-locked');
    await writeNative(f.Y, 'MEMORY.md', 'b');
    const lock = programLock(f.Y.home, []);
    let addDone!: () => void;
    const addFinished = new Promise<void>((resolve) => {
      addDone = resolve;
    });
    // Same stall, but bounded: with the lock, add can't finish while pull holds it.
    const { backend, stalled } = stallingBackend(f.backend, f.yBaseGeneration, () =>
      Promise.race([addFinished, sleep(300)]),
    );
    const pull = lock('stak pull', commandFn(f, 'pull', backend));
    const add = (async () => {
      await sleep(20);
      try {
        return await lock('stak add', commandFn(f, 'add', f.backend));
      } finally {
        addDone();
      }
    })();
    await Promise.all([pull, add]);
    expect(stalled()).toBe(true);

    const final = await snapshot(f);
    expect(final.local['notes/new.md']).toBe(`present:${hashOf('from X')}`);
    expect(final.local['notes/MEMORY.md']).toBe(`present:${hashOf('b')}`);
  });
});
