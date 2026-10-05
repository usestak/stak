import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SkillTreeEntry } from '@stack/shared';
import type {
  EnvironmentLock,
  LockedSkill,
  RestorationStrategy,
} from '@stack/spec';
import { ingestSkill, verifyStoredSkill } from '@stack/store';
import { hashSkillDirectory } from '@stack/shared';

import {
  applyStackUse,
  prepareStackUse,
  resolveSkillSelector,
  setSkillPaused,
} from './composition.js';
import { loadProjectedLocalEnvironment } from './projection.js';
import { loadMainEnvironment } from './state.js';
import {
  approveSkillSourceVersion,
  diffSkillTrees,
  resolveSkillSourceLatest,
} from './skill-source.js';

const MACHINE = '00000000-0000-4000-8000-0000000000aa';
const dirs: string[] = [];
const temp = async (prefix = 'stak-lifecycle-') => {
  const value = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const reference = (revision: string, expectedContentHash: string) =>
  ({
    strategy: 'reference',
    reference: {
      remote: 'https://github.com/acme/skills.git',
      revision,
      path: 'skills/thing',
      expectedContentHash,
    },
  }) satisfies RestorationStrategy;
const snapshot = (reason: string) =>
  ({
    strategy: 'snapshot',
    snapshotId: 'snap_aaaaaaaa',
    reason,
  }) as RestorationStrategy;

type SkillSpec = {
  entryId: string;
  name: string;
  contentHash: string;
  restoration?: RestorationStrategy;
  paused?: boolean;
  omitPausedField?: boolean;
};

/** Write a valid `main` environment to disk with the given (direct) Skills. */
const seedMain = async (skills: SkillSpec[]): Promise<string> => {
  const stackHome = await temp();
  const envDir = path.join(stackHome, 'environments', 'main');
  const baselineDir = path.join(
    stackHome,
    'state',
    'machines',
    MACHINE,
    'environments',
  );
  await mkdir(envDir, { recursive: true });
  await mkdir(baselineDir, { recursive: true });
  await writeFile(
    path.join(stackHome, 'machine.json'),
    JSON.stringify({
      schemaVersion: 1,
      machineId: MACHINE,
      createdAt: '2026-10-05T00:00:00.000Z',
      platform: 'linux',
      arch: 'x64',
    }),
  );
  const manifest = {
    schemaVersion: 1,
    name: 'main',
    skills: skills.map((s) => ({
      id: s.entryId,
      name: s.name,
      requirement: 'required' as const,
    })),
    stacks: [],
    overrides: {},
  };
  await writeFile(
    path.join(envDir, 'environment.yaml'),
    stringifyYaml(manifest),
  );
  const lock: EnvironmentLock = {
    schemaVersion: 1,
    resolvedAt: '2026-10-05T00:00:00.000Z',
    skills: Object.fromEntries(
      skills.map((s) => {
        const locked: LockedSkill = {
          name: s.name,
          description: `${s.name} description`,
          contentHash: s.contentHash,
          observedSources: [],
          localContent: { available: true, contentHash: s.contentHash },
          restoration: s.restoration ?? snapshot('local'),
          ...(s.paused === true && !s.omitPausedField ? { paused: true } : {}),
        };
        return [s.entryId, locked];
      }),
    ),
  };
  await writeFile(
    path.join(envDir, 'stack.lock.json'),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  await writeFile(
    path.join(baselineDir, 'main.json'),
    JSON.stringify({
      schemaVersion: 1,
      machineId: MACHINE,
      environment: 'main',
      capturedAt: '2026-10-05T00:00:00.000Z',
      skills: Object.fromEntries(
        skills.map((s) => [
          s.entryId,
          { contentHash: s.contentHash, locations: [] },
        ]),
      ),
    }),
  );
  return stackHome;
};

const file = (relativePath: string, content: string): SkillTreeEntry => ({
  relativePath,
  type: 'file',
  content: Buffer.from(content, 'utf8'),
});

/* ------------------------------- IDENTITY ------------------------------- */

describe('stable Skill identity (P2 §2)', () => {
  it('two same-named Skills with different stable ids stay independent', async () => {
    const stackHome = await seedMain([
      { entryId: 'skill_dup00001', name: 'review-pr', contentHash: hash('a') },
      { entryId: 'skill_dup00002', name: 'review-pr', contentHash: hash('b') },
    ]);
    // A display-name selector cannot collapse them — it is ambiguous.
    expect(
      resolveSkillSelector(
        (await loadMainEnvironment({ stackHome })).lock,
        'review-pr',
      ),
    ).toEqual({
      status: 'ambiguous',
      matches: ['skill_dup00001', 'skill_dup00002'],
    });
    // Each stable id resolves independently.
    expect(
      resolveSkillSelector(
        (await loadMainEnvironment({ stackHome })).lock,
        'skill_dup00002',
      ),
    ).toEqual({ status: 'ok', entryId: 'skill_dup00002' });
    // Pausing one by stable id never touches the other.
    await setSkillPaused({
      stackHome,
      selector: 'skill_dup00001',
      paused: true,
    });
    const projected = await loadProjectedLocalEnvironment({ stackHome });
    expect(projected.skills.map((s) => s.entryId)).toEqual(['skill_dup00002']);
    expect(projected.skills[0]?.contentHash).toBe(hash('b'));
  });
});

/* -------------------------- BACKWARD COMPATIBILITY -------------------------- */

describe('backward compatibility (P2 §5/§15)', () => {
  it('a pre-P2 lock without a paused field loads and projects as active', async () => {
    const stackHome = await seedMain([
      {
        entryId: 'skill_legacy01',
        name: 'legacy',
        contentHash: hash('c'),
        omitPausedField: true,
      },
    ]);
    const lockText = await readFile(
      path.join(stackHome, 'environments', 'main', 'stack.lock.json'),
      'utf8',
    );
    expect(lockText).not.toContain('paused'); // truly absent on disk
    const projected = await loadProjectedLocalEnvironment({ stackHome });
    expect(projected.skills.map((s) => s.entryId)).toEqual(['skill_legacy01']);
  });
});

/* ------------------------------ PAUSE / RESUME ------------------------------ */

describe('pause / resume (P2 §5/§6)', () => {
  it('pause retains version/provenance and excludes from projection; resume restores it', async () => {
    const stackHome = await seedMain([
      {
        entryId: 'skill_active001',
        name: 'alpha',
        contentHash: hash('a'),
        restoration: reference('a'.repeat(40), hash('a')),
      },
      { entryId: 'skill_active002', name: 'beta', contentHash: hash('b') },
    ]);

    const paused = await setSkillPaused({
      stackHome,
      selector: 'alpha',
      paused: true,
    });
    expect(paused).toMatchObject({
      status: 'ok',
      entryId: 'skill_active001',
      paused: true,
      changed: true,
    });

    // Excluded from the real projection path.
    let projected = await loadProjectedLocalEnvironment({ stackHome });
    expect(projected.skills.map((s) => s.entryId)).toEqual(['skill_active002']);

    // Retained in the lock with version + provenance + metadata intact.
    const lock = (await loadMainEnvironment({ stackHome })).lock;
    expect(lock.skills['skill_active001']).toMatchObject({
      name: 'alpha',
      contentHash: hash('a'),
      paused: true,
      restoration: {
        strategy: 'reference',
        reference: { revision: 'a'.repeat(40) },
      },
    });

    // Pausing again is a no-op (changed: false).
    expect(
      await setSkillPaused({ stackHome, selector: 'alpha', paused: true }),
    ).toMatchObject({ changed: false });

    // Resume restores projection and clears the flag entirely.
    const resumed = await setSkillPaused({
      stackHome,
      selector: 'skill_active001',
      paused: false,
    });
    expect(resumed).toMatchObject({
      status: 'ok',
      changed: true,
      paused: false,
    });
    projected = await loadProjectedLocalEnvironment({ stackHome });
    expect(projected.skills.map((s) => s.entryId).sort()).toEqual([
      'skill_active001',
      'skill_active002',
    ]);
    const resumedLock = (await loadMainEnvironment({ stackHome })).lock;
    expect('paused' in (resumedLock.skills['skill_active001'] ?? {})).toBe(
      false,
    );
  });

  it('pause is NOT remove: the Skill entry stays in the manifest and lock', async () => {
    const stackHome = await seedMain([
      { entryId: 'skill_keep0001', name: 'kept', contentHash: hash('a') },
    ]);
    await setSkillPaused({ stackHome, selector: 'kept', paused: true });
    const state = await loadMainEnvironment({ stackHome });
    // Unlike remove, the desired entry and its locked version are still present.
    expect(state.manifest.skills.map((s) => s.id)).toEqual(['skill_keep0001']);
    expect(state.lock.skills['skill_keep0001']?.contentHash).toBe(hash('a'));
  });

  it('an unknown selector is not-found; the operation is a no-op', async () => {
    const stackHome = await seedMain([
      { entryId: 'skill_only00001', name: 'only', contentHash: hash('a') },
    ]);
    expect(
      await setSkillPaused({ stackHome, selector: 'ghost', paused: true }),
    ).toEqual({ status: 'not-found' });
  });

  it('re-resolving the environment preserves paused (buildState carry-forward)', async () => {
    const stackHome = await seedMain([
      { entryId: 'skill_direct001', name: 'direct', contentHash: hash('a') },
    ]);
    await setSkillPaused({ stackHome, selector: 'direct', paused: true });

    // Build a local stack and `use` it — this re-resolves + rewrites the lock via buildState.
    const stackRoot = await temp('stak-stack-');
    const skillDir = path.join(stackRoot, 'skills', 'shared');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: shared\ndescription: Shared skill\n---\nbody\n',
    );
    await writeFile(
      path.join(stackRoot, 'stack.yaml'),
      'schemaVersion: 1\nname: layer\ndescription: layer\nextends: []\nskills:\n  - path: ./skills/shared\n    requirement: required\n',
    );
    const proposal = await prepareStackUse({ stackHome, input: stackRoot });
    await applyStackUse(proposal);

    const lock = (await loadMainEnvironment({ stackHome })).lock;
    expect(lock.skills['skill_direct001']?.paused).toBe(true); // carried forward
    const projected = await loadProjectedLocalEnvironment({ stackHome });
    expect(projected.skills.map((s) => s.entryId)).not.toContain(
      'skill_direct001',
    );
  });
});

/* ------------------------------ SOURCE-LATEST ------------------------------ */

describe('source-latest (P2 §3/§9)', () => {
  const locked = (
    restoration: RestorationStrategy,
  ): Pick<LockedSkill, 'restoration'> => ({ restoration });

  it('same Git revision → same (identity comparison, not ordering)', async () => {
    const rev = 'f'.repeat(40);
    const result = await resolveSkillSourceLatest({
      locked: locked(reference(rev, hash('a'))),
      resolveRemoteHead: async () => rev,
    });
    expect(result).toEqual({
      status: 'same',
      approvedRevision: rev,
      sourceRevision: rev,
    });
  });

  it('different Git revision → different; compared by identity even when approved sorts "higher"', async () => {
    // approved starts with 'f' (sorts after source 'a') — ordering must NOT be used.
    const approved = `f${'0'.repeat(39)}`;
    const source = `a${'0'.repeat(39)}`;
    const result = await resolveSkillSourceLatest({
      locked: locked(reference(approved, hash('a'))),
      resolveRemoteHead: async () => source,
    });
    expect(result).toEqual({
      status: 'different',
      approvedRevision: approved,
      sourceRevision: source,
    });
  });

  it('Local source → uncheckable(local)', async () => {
    expect(
      await resolveSkillSourceLatest({ locked: locked(snapshot('local')) }),
    ).toEqual({
      status: 'uncheckable',
      reason: 'local',
    });
  });

  it('dirty/modified source → uncheckable(dirty)', async () => {
    expect(
      await resolveSkillSourceLatest({
        locked: locked(snapshot('modified-source')),
      }),
    ).toEqual({
      status: 'uncheckable',
      reason: 'dirty',
    });
  });

  it('ambiguous source → uncheckable(ambiguous)', async () => {
    expect(
      await resolveSkillSourceLatest({
        locked: locked(snapshot('ambiguous-source')),
      }),
    ).toEqual({
      status: 'uncheckable',
      reason: 'ambiguous',
    });
  });

  it('unreachable Git remote (resolver returns null) → uncheckable(unreachable)', async () => {
    const result = await resolveSkillSourceLatest({
      locked: locked(reference('a'.repeat(40), hash('a'))),
      resolveRemoteHead: async () => null,
    });
    expect(result).toEqual({ status: 'uncheckable', reason: 'unreachable' });
  });

  it('unknown snapshot source → uncheckable(unreachable), never a false update', async () => {
    expect(
      await resolveSkillSourceLatest({
        locked: locked(snapshot('unknown-source')),
      }),
    ).toEqual({
      status: 'uncheckable',
      reason: 'unreachable',
    });
  });
});

/* --------------------------------- DIFF --------------------------------- */

describe('candidate diff (P2 §10)', () => {
  const base = [file('SKILL.md', 'A'), file('ref.md', 'B')];

  it('identical trees → no change', () => {
    expect(
      diffSkillTrees(base, [file('SKILL.md', 'A'), file('ref.md', 'B')]),
    ).toEqual({
      changed: false,
      files: [],
    });
  });

  it('modified file', () => {
    const diff = diffSkillTrees(base, [
      file('SKILL.md', 'A2'),
      file('ref.md', 'B'),
    ]);
    expect(diff).toEqual({
      changed: true,
      files: [{ relativePath: 'SKILL.md', kind: 'modified' }],
    });
  });

  it('added file', () => {
    const diff = diffSkillTrees(base, [...base, file('new.md', 'C')]);
    expect(diff.files).toEqual([{ relativePath: 'new.md', kind: 'added' }]);
  });

  it('removed file', () => {
    const diff = diffSkillTrees(base, [file('SKILL.md', 'A')]);
    expect(diff.files).toEqual([{ relativePath: 'ref.md', kind: 'removed' }]);
  });

  it('multi-file candidate (add + modify + remove together)', () => {
    const diff = diffSkillTrees(base, [
      file('SKILL.md', 'A3'),
      file('new.md', 'C'),
    ]);
    expect(diff.files).toEqual([
      { relativePath: 'SKILL.md', kind: 'modified' },
      { relativePath: 'new.md', kind: 'added' },
      { relativePath: 'ref.md', kind: 'removed' },
    ]);
  });
});

/* -------------------------------- APPROVAL -------------------------------- */

describe('approval (P2 §4)', () => {
  const makeSkillDir = async (body: string) => {
    const dir = await temp('stak-approve-src-');
    await writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: thing\ndescription: Thing\n---\n${body}\n`,
    );
    return dir;
  };

  it('advances desired version only, preserves the prior immutable version, mutates no remote', async () => {
    // Old approved content ingested into the Store.
    const oldDir = await makeSkillDir('old-body');
    const oldHash = (await hashSkillDirectory(oldDir)).hash;
    const newDir = await makeSkillDir('new-body');
    const newHash = (await hashSkillDirectory(newDir)).hash;

    const stackHome = await seedMain([
      {
        entryId: 'skill_approve01',
        name: 'thing',
        contentHash: oldHash,
        restoration: reference('old'.padEnd(40, '0'), oldHash),
      },
    ]);
    await ingestSkill({
      stackHome,
      sourcePath: oldDir,
      expectedContentHash: oldHash,
    });

    const ingest = vi.fn(async () => {
      await ingestSkill({
        stackHome,
        sourcePath: newDir,
        expectedContentHash: newHash,
      });
      return { reused: false };
    });
    const result = await approveSkillSourceVersion({
      stackHome,
      selector: 'thing',
      candidate: {
        revision: 'new'.padEnd(40, '0'),
        contentHash: newHash,
        entries: [],
      },
      ingest,
    });

    expect(result).toMatchObject({
      status: 'ok',
      changed: true,
      approvedContentHash: newHash,
      previousContentHash: oldHash,
    });
    expect(ingest).toHaveBeenCalledOnce();

    const state = await loadMainEnvironment({ stackHome });
    // Desired version advanced for the stable id...
    expect(state.lock.skills['skill_approve01']?.contentHash).toBe(newHash);
    expect(state.lock.skills['skill_approve01']?.restoration).toMatchObject({
      strategy: 'reference',
      reference: {
        revision: 'new'.padEnd(40, '0'),
        expectedContentHash: newHash,
      },
    });
    // ...the desired MANIFEST membership did not change (approval ≠ add/remove).
    expect(state.manifest.skills.map((s) => s.id)).toEqual(['skill_approve01']);
    // The prior immutable imported version is still intact in the Store.
    expect(
      (await verifyStoredSkill({ stackHome, contentHash: oldHash })).state,
    ).toBe('available');
  });

  it('refuses to approve over dirty/local (snapshot) content without overwriting it', async () => {
    const stackHome = await seedMain([
      {
        entryId: 'skill_dirty0001',
        name: 'dirtyone',
        contentHash: hash('a'),
        restoration: snapshot('modified-source'),
      },
    ]);
    const ingest = vi.fn(async () => ({ reused: false }));
    const result = await approveSkillSourceVersion({
      stackHome,
      selector: 'dirtyone',
      candidate: {
        revision: 'x'.repeat(40),
        contentHash: hash('z'),
        entries: [],
      },
      ingest,
    });
    expect(result).toEqual({ status: 'not-checkable', reason: 'dirty' });
    expect(ingest).not.toHaveBeenCalled(); // nothing imported, nothing overwritten
    expect(
      (await loadMainEnvironment({ stackHome })).lock.skills['skill_dirty0001']
        ?.contentHash,
    ).toBe(hash('a'));
  });

  it('a candidate identical to the approved version is a no-op (changed: false)', async () => {
    const stackHome = await seedMain([
      {
        entryId: 'skill_same00001',
        name: 'same',
        contentHash: hash('a'),
        restoration: reference('r'.repeat(40), hash('a')),
      },
    ]);
    const ingest = vi.fn(async () => ({ reused: true }));
    const result = await approveSkillSourceVersion({
      stackHome,
      selector: 'same',
      candidate: {
        revision: 'r'.repeat(40),
        contentHash: hash('a'),
        entries: [],
      },
      ingest,
    });
    expect(result).toMatchObject({ status: 'ok', changed: false });
    expect(ingest).not.toHaveBeenCalled();
  });
});
