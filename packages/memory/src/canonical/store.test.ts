import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CANONICAL_MAIN_SCHEMA_VERSION } from './domain.js';
import {
  canonicalStorePaths,
  clearPendingMerge,
  readCanonicalBase,
  readCanonicalMain,
  readPendingMerge,
  readProjection,
  writeCanonicalBase,
  writeCanonicalMain,
  writePendingMerge,
  writeProjection,
} from './store.js';

let stackHome: string;

beforeEach(async () => {
  stackHome = await mkdtemp(path.join(os.tmpdir(), 'stak-canonical-'));
});

afterEach(async () => {
  await rm(stackHome, { recursive: true, force: true });
});

describe('canonical main', () => {
  it('returns an empty manifest when nothing has been written', async () => {
    const main = await readCanonicalMain(stackHome);
    expect(main).toEqual({
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [],
    });
  });

  it('round-trips a written manifest', async () => {
    const main = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        { projectId: 'prj_0123456789abcdefghjkmnpqrs', documents: [] },
      ],
    };
    await writeCanonicalMain(stackHome, main);
    expect(await readCanonicalMain(stackHome)).toEqual(main);
  });
});

describe('canonical base', () => {
  it('returns null when no base has been synced yet', async () => {
    expect(await readCanonicalBase(stackHome)).toBeNull();
  });

  it('round-trips a base', async () => {
    const base = {
      generation: 3,
      main: { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [] },
    };
    await writeCanonicalBase(stackHome, base);
    expect(await readCanonicalBase(stackHome)).toEqual(base);
  });
});

describe('pending merge', () => {
  const testMergeSchema = z.object({
    basedOnGeneration: z.number(),
    merged: z.unknown(),
    conflicts: z.array(z.unknown()),
  });

  it('returns null when there is no pending merge', async () => {
    expect(await readPendingMerge(stackHome, testMergeSchema)).toBeNull();
  });

  it('round-trips a pending merge, and clears it', async () => {
    const merge = {
      basedOnGeneration: 5,
      merged: { a: 1 },
      conflicts: [{ b: 2 }],
    };
    await writePendingMerge(stackHome, merge);
    expect(await readPendingMerge(stackHome, testMergeSchema)).toEqual(merge);
    await clearPendingMerge(stackHome);
    expect(await readPendingMerge(stackHome, testMergeSchema)).toBeNull();
  });
});

describe('projections', () => {
  it('returns an empty projection file when none exists', async () => {
    expect(await readProjection(stackHome, 'claude')).toEqual({
      schemaVersion: 1,
      projects: {},
    });
  });

  it('round-trips a projection file per adapter', async () => {
    const file = {
      schemaVersion: 1 as const,
      projects: {
        prj_0123456789abcdefghjkmnpqrs: {
          'notes/a.md': 'sha256:' + '0'.repeat(64),
        },
      },
    };
    await writeProjection(stackHome, 'claude', file);
    expect(await readProjection(stackHome, 'claude')).toEqual(file);
    // A different adapter id is a different file.
    expect(await readProjection(stackHome, 'cursor')).toEqual({
      schemaVersion: 1,
      projects: {},
    });
  });
});

describe('canonicalStorePaths', () => {
  it('scopes every path under memory/canonical', () => {
    const paths = canonicalStorePaths(stackHome);
    expect(paths.main).toContain(path.join('memory', 'canonical', 'main.json'));
    expect(paths.base).toContain(path.join('memory', 'canonical', 'base.json'));
    expect(paths.merge).toContain(
      path.join('memory', 'canonical', 'merge.json'),
    );
    expect(paths.projections('claude')).toContain(
      path.join('memory', 'projections', 'claude.json'),
    );
  });
});
