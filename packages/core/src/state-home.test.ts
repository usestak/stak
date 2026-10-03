import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  StackStateError,
  hasRecognizableStakState,
  resolveStackHome,
} from './state.js';

const roots: string[] = [];
const temp = async () => {
  const r = await mkdtemp(path.join(tmpdir(), 'stak-home-'));
  roots.push(r);
  return r;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

/** Write a recognizable state marker (default: machine.json) into `home`. */
const seedState = async (home: string, marker = 'machine.json') => {
  const file = path.join(home, marker);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{}', 'utf8');
};
const seedDir = async (
  home: string,
  dirMarker = path.join('memory', 'objects'),
) => {
  await mkdir(path.join(home, dirMarker), { recursive: true });
};
const emptyDir = async (home: string) => {
  await mkdir(home, { recursive: true });
};

/** A HOME layout: returns the fake homeDir whose `.stak`/`.stack` we control. */
const homeWith = async (
  setup: (dirs: { stak: string; stack: string }) => Promise<void>,
) => {
  const homeDir = await temp();
  const dirs = {
    stak: path.join(homeDir, '.stak'),
    stack: path.join(homeDir, '.stack'),
  };
  await setup(dirs);
  return { homeDir, ...dirs };
};

const resolve = (homeDir: string, env: NodeJS.ProcessEnv = {}) =>
  resolveStackHome({ env, homeDir });

describe('STAK state home resolution (R3)', () => {
  // --- Explicit env vars -----------------------------------------------------
  it('1. STAK_HOME only → STAK_HOME', async () => {
    const h = await temp();
    expect(resolve('/unused', { STAK_HOME: h })).toBe(path.resolve(h));
  });

  it('2. STACK_HOME only → legacy path', async () => {
    const h = await temp();
    expect(resolve('/unused', { STACK_HOME: h })).toBe(path.resolve(h));
  });

  it('3. both set to the same normalized path → accepted', async () => {
    const h = await temp();
    const withSlash = `${h}${path.sep}`;
    expect(resolve('/unused', { STAK_HOME: h, STACK_HOME: withSlash })).toBe(
      path.resolve(h),
    );
  });

  it('4. both set to different paths → fail closed', async () => {
    const a = await temp();
    const b = await temp();
    expect(() => resolve('/unused', { STAK_HOME: a, STACK_HOME: b })).toThrow(
      StackStateError,
    );
    try {
      resolve('/unused', { STAK_HOME: a, STACK_HOME: b });
    } catch (error) {
      expect((error as StackStateError).code).toBe('ambiguous-home');
      expect((error as Error).message).toContain('STAK_HOME');
      expect((error as Error).message).toContain('STACK_HOME');
    }
  });

  it('15/16. explicit var bypasses implicit-directory ambiguity', async () => {
    const explicit = await temp();
    const { homeDir } = await homeWith(async ({ stak, stack }) => {
      await seedState(stak);
      await seedState(stack); // would be ambiguous implicitly…
    });
    // …but an explicit var wins and never consults the directories.
    expect(resolve(homeDir, { STAK_HOME: explicit })).toBe(
      path.resolve(explicit),
    );
    expect(resolve(homeDir, { STACK_HOME: explicit })).toBe(
      path.resolve(explicit),
    );
  });

  // --- Implicit discovery ----------------------------------------------------
  it('5/6/11. neither var, neither dir (or both empty) → ~/.stak, never ~/.stack', async () => {
    const neither = await homeWith(async () => undefined);
    expect(resolve(neither.homeDir)).toBe(path.resolve(neither.stak));

    const both = await homeWith(async ({ stak, stack }) => {
      await emptyDir(stak);
      await emptyDir(stack);
    });
    expect(resolve(both.homeDir)).toBe(path.resolve(both.stak));
  });

  it('7. ~/.stak state only → ~/.stak', async () => {
    const h = await homeWith(async ({ stak }) => seedState(stak));
    expect(resolve(h.homeDir)).toBe(path.resolve(h.stak));
  });

  it('8. ~/.stack state only → ~/.stack (adopted in place)', async () => {
    const h = await homeWith(async ({ stack }) => seedState(stack));
    expect(resolve(h.homeDir)).toBe(path.resolve(h.stack));
  });

  it('9. ~/.stak empty + ~/.stack state → ~/.stack', async () => {
    const h = await homeWith(async ({ stak, stack }) => {
      await emptyDir(stak);
      await seedState(stack);
    });
    expect(resolve(h.homeDir)).toBe(path.resolve(h.stack));
  });

  it('10. ~/.stack empty + ~/.stak state → ~/.stak', async () => {
    const h = await homeWith(async ({ stak, stack }) => {
      await seedState(stak);
      await emptyDir(stack);
    });
    expect(resolve(h.homeDir)).toBe(path.resolve(h.stak));
  });

  it('12. both contain recognized state → ambiguity error (no guess)', async () => {
    const h = await homeWith(async ({ stak, stack }) => {
      await seedState(stak);
      await seedState(stack);
    });
    try {
      resolve(h.homeDir);
      throw new Error('expected ambiguity error');
    } catch (error) {
      expect(error).toBeInstanceOf(StackStateError);
      expect((error as StackStateError).code).toBe('ambiguous-home');
      expect((error as Error).message).toContain('STAK_HOME');
    }
  });

  it('13. unknown file in ~/.stak + state in ~/.stack → legacy ~/.stack', async () => {
    const h = await homeWith(async ({ stak, stack }) => {
      await mkdir(stak, { recursive: true });
      await writeFile(path.join(stak, 'notes.txt'), 'unrelated', 'utf8');
      await seedState(stack);
    });
    expect(resolve(h.homeDir)).toBe(path.resolve(h.stack));
  });

  it('14. unknown file in ~/.stack + state in ~/.stak → ~/.stak', async () => {
    const h = await homeWith(async ({ stak, stack }) => {
      await seedState(stak);
      await mkdir(stack, { recursive: true });
      await writeFile(path.join(stack, 'README'), 'unrelated', 'utf8');
    });
    expect(resolve(h.homeDir)).toBe(path.resolve(h.stak));
  });

  it('17. Windows-equivalent casing does not falsely conflict', () => {
    if (process.platform !== 'win32') return; // casing rule is Windows-only
    const a = 'C:\\Users\\Dev\\.stak';
    const b = 'c:\\users\\dev\\.stak';
    expect(() =>
      resolve('/unused', { STAK_HOME: a, STACK_HOME: b }),
    ).not.toThrow();
  });

  it('18. a resolved home is always absolute (path fence not weakened)', async () => {
    const h = await homeWith(async ({ stak }) => seedState(stak));
    expect(path.isAbsolute(resolve(h.homeDir))).toBe(true);
  });
});

describe('hasRecognizableStakState markers (R3)', () => {
  it('detects each independent marker on its own', async () => {
    for (const marker of [
      'machine.json',
      'auth.json',
      path.join('environments', 'main', 'environment.yaml'),
      path.join('environments', 'main', 'stack.lock.json'),
      path.join('memory', 'manifests', 'current.json'),
      path.join('memory', 'projects-local.json'),
      path.join('memory', 'recovery-state.json'),
    ]) {
      const home = await temp();
      await seedState(home, marker);
      expect(hasRecognizableStakState(home)).toBe(true);
    }
    // The content-store directory marker.
    const objHome = await temp();
    await seedDir(objHome);
    expect(hasRecognizableStakState(objHome)).toBe(true);
  });

  it('a login-only home (auth.json alone) is recognizable', async () => {
    const home = await temp();
    await seedState(home, 'auth.json');
    expect(hasRecognizableStakState(home)).toBe(true);
  });

  it('empty / unrelated contents are NOT recognizable', async () => {
    const empty = await temp();
    expect(hasRecognizableStakState(empty)).toBe(false);

    const file = await temp();
    await writeFile(path.join(file, 'random.txt'), 'x', 'utf8');
    expect(hasRecognizableStakState(file)).toBe(false);

    const dir = await temp();
    await mkdir(path.join(dir, 'unrelated'), { recursive: true });
    expect(hasRecognizableStakState(dir)).toBe(false);
  });

  it('a non-existent directory is NOT recognizable', async () => {
    expect(hasRecognizableStakState(path.join(await temp(), 'nope'))).toBe(
      false,
    );
  });
});

describe('synthetic pre-rebrand legacy state is adopted in place (R3 §20)', () => {
  it('selects ~/.stack unchanged; nothing is moved/copied and no ~/.stak is created', async () => {
    // A representative pre-rebrand real-dogfood layout under legacy ~/.stack.
    const { homeDir, stak, stack } = await homeWith(
      async ({ stack: legacy }) => {
        const files: Record<string, string> = {
          'auth.json': '{"token":"REDACTED-TEST","apiUrl":"https://api.test"}',
          'machine.json': '{"schemaVersion":1,"machineId":"m-1"}',
          [path.join('environments', 'main', 'environment.yaml')]:
            'schemaVersion: 1\nname: main\n',
          [path.join('environments', 'main', 'stack.lock.json')]:
            '{"schemaVersion":1}',
          [path.join('memory', 'manifests', 'current.json')]:
            '{"schemaVersion":1,"items":[]}',
          [path.join('memory', 'projects-local.json')]:
            '{"schemaVersion":1,"projects":[],"bindings":[]}',
          [path.join('memory', 'recovery-state.json')]: '{"schemaVersion":1}',
        };
        for (const [rel, body] of Object.entries(files)) {
          const file = path.join(legacy, rel);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, body, 'utf8');
        }
        await mkdir(path.join(legacy, 'memory', 'objects'), {
          recursive: true,
        });
      },
    );

    const before = await readFile(path.join(stack, 'auth.json'), 'utf8');

    // Resolution with no env vars adopts the legacy home IN PLACE.
    const resolved = resolveStackHome({ env: {}, homeDir });
    expect(resolved).toBe(path.resolve(stack));

    // No ~/.stak was created, and the legacy bytes are untouched.
    expect(existsSync(stak)).toBe(false);
    expect(await readFile(path.join(stack, 'auth.json'), 'utf8')).toBe(before);
    expect(
      await readFile(
        path.join(stack, 'memory', 'manifests', 'current.json'),
        'utf8',
      ),
    ).toBe('{"schemaVersion":1,"items":[]}');
  });
});
