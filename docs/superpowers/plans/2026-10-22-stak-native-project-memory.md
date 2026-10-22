# STAK-native Project Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make STAK own the canonical, agent-neutral Project Memory (keyed by `(projectId, canonicalPath)` documents), with Claude Code as a two-way adapter, local-store migration from the v1 format, a v2 Cloud bundle with three-way merge across machines, and server/CLI wiring — exactly as specified in `docs/superpowers/specs/2026-10-22-stak-native-project-memory-design.md`.

**Architecture:** A new `packages/memory/src/canonical/` module holds the pure domain model, the N/P/C sync engine, the three-way merge engine, and the local-store migration — all file I/O-free except for a thin `store.ts`. A Claude-specific adapter maps canonical documents to Claude's native files. The existing content-addressed object store, Project ID registry, and `RemoteMemoryBackend` (with its `expectedParent` optimistic concurrency) are reused unchanged. CLI commands (`status`, `add`, `push`, `pull`, and new `memory resolve`/`diff`/`materialize`) call into this engine through dependency-injected functions, following the existing pattern in `packages/cli/src/commands/push.ts`.

**Tech Stack:** TypeScript, Zod, Vitest, existing `@stack/memory` / `@stack/cli` / `@stack/cloud-server` / `@stack/spec` packages.

## Global Constraints

- **Scope lock:** implement ONLY what `docs/superpowers/specs/2026-10-22-stak-native-project-memory-design.md` describes. No Cursor/Codex adapters, no "User Memory" global scope migration, no semantic/structured-fact memory, no rename detection, no tombstone pruning. These are explicitly deferred (spec §13).
- **No architecture changes beyond the spec.** Reuse `@stack/memory`'s existing Project ID registry (`packages/memory/src/project/registry.ts`), content-addressed store (`packages/memory/src/store.ts`), and `RemoteMemoryBackend` contract (`packages/memory/src/remote/backend.ts`) as-is.
- **Byte-exact content.** Canonical document bytes are never reformatted, re-encoded, or line-ending-normalized (spec §4.1, §A.1).
- **Paths:** canonical paths are `/`-separated, NFC-normalized, validated with the existing `validateTreePath` (`packages/shared/src/tree.ts`), and compared case-sensitively (spec §4.2, §A.1).
- **Safety invariant (non-negotiable):** native files are only overwritten when N = P (native hash equals last-synced hash) (spec §6, §A.2).
- **Mass-delete guard (non-negotiable):** a missing native project root means "not materialized here", never "delete everything" (spec §6).
- **Tombstone-resurrection guard:** a native file whose hash equals a tombstone's `lastContentHash` is never re-imported as new (spec §7, §A.2).
- **All state files are atomic writes** using the existing `atomicWriteFile` pattern (`packages/memory/src/remote/secure-file.ts`) or `writeMemoryManifest`'s pattern (`packages/memory/src/store.ts`).
- **Machine-local files never upload:** `canonical/base.json`, `canonical/merge.json`, `projections/*.json` must be added to the bundle exclusion list and to `STATE_EXCLUDE_PATHS` in `packages/core/src/state.ts`.
- **Upgrade messaging:** any server/CLI message about an incompatible CLI version must say `npm i -g @memstk/cli@beta`, never `@latest` (spec §9.3; `latest` intentionally stays at `0.1.2`).
- **If a contradiction or implementation-blocking constraint is found that the spec does not resolve, STOP and report it — do not invent a new design.**

---

## File Structure Overview

```
packages/memory/src/canonical/
  domain.ts            # CanonicalDoc, CanonicalProjectMemory, CanonicalMainManifest (Task 1)
  paths.ts             # namespace + path validation helpers (Task 1)
  store.ts             # read/write main.json, base.json, merge.json, projections/*.json (Task 2)
  sync.ts              # N/P/C comparison engine (Task 3)
  merge.ts             # three-way document merge + keep-both naming (Task 4)
  claude-project-adapter.ts   # ProjectMemoryAdapter for Claude (Task 5)
  migrate.ts           # resumable v1 -> v2 local migration (Task 6)
  convert-v1.ts        # deterministic old-bundle -> canonical converter (Task 7)
  push.ts              # push algorithm: fast-forward / merge / retry (Task 9)
  pull.ts              # pull + materialize orchestration (Task 10)
packages/memory/src/remote/bundle-codec.ts   # extended for stack-mem-bundle-v2 (Task 7)
packages/memory/src/remote/backend.ts        # version-gate policy in createGeneration (Task 8)
packages/memory/src/remote/project-counts.ts # v2 support (Task 8)
packages/cli/src/memory/canonical-ops.ts     # CLI-facing glue (Task 11)
packages/cli/src/commands/status.ts          # extended (Task 11)
packages/cli/src/commands/add.ts             # extended (Task 11)
packages/cli/src/commands/push.ts            # extended (Task 12)
packages/cli/src/commands/pull.ts            # extended (Task 12)
packages/cli/src/commands/memory.ts          # plus resolve/diff/materialize subcommands (Task 13)
packages/core/src/state.ts                   # exclusion list update (Task 2)
docs/memory.md                               # user docs update (Task 14)
```

---

### Task 1: Canonical domain model and path rules

**Files:**
- Create: `packages/memory/src/canonical/domain.ts`
- Create: `packages/memory/src/canonical/paths.ts`
- Test: `packages/memory/src/canonical/domain.test.ts`
- Test: `packages/memory/src/canonical/paths.test.ts`

**Interfaces:**
- Produces (from `paths.ts`): `NAMESPACES`, `type Namespace = "notes" | "instructions" | "agents"`, `InvalidCanonicalPathError`, `validateCanonicalPath(path: string): string`, `namespaceOf(path: string): Namespace | null`, `agentOfAgentsPath(path: string): string | null`.
- Produces (from `domain.ts`): `CANONICAL_MAIN_SCHEMA_VERSION`, `canonicalDocPresentSchema`, `canonicalDocDeletedSchema`, `canonicalDocSchema`, `type CanonicalDoc`, `canonicalProjectMemorySchema`, `type CanonicalProjectMemory`, `canonicalMainManifestSchema`, `type CanonicalMainManifest`, `emptyCanonicalMain()`, `canonicalDigest(main): string`, `projectMemoryOf(main, projectId)`, `documentOf(main, projectId, path)`.

- [ ] **Step 1: Write the failing tests for path rules**

Create `packages/memory/src/canonical/paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  agentOfAgentsPath,
  namespaceOf,
  validateCanonicalPath,
} from './paths.js';

describe('validateCanonicalPath', () => {
  it('accepts a normal notes path', () => {
    expect(validateCanonicalPath('notes/auth-decisions.md')).toBe(
      'notes/auth-decisions.md',
    );
  });

  it('rejects a path outside the three namespaces', () => {
    expect(() => validateCanonicalPath('random/file.md')).toThrow();
  });

  it('rejects traversal', () => {
    expect(() => validateCanonicalPath('notes/../secret.md')).toThrow();
  });

  it('rejects backslashes and absolute paths', () => {
    expect(() => validateCanonicalPath('notes\\x.md')).toThrow();
    expect(() => validateCanonicalPath('/notes/x.md')).toThrow();
    expect(() => validateCanonicalPath('C:/notes/x.md')).toThrow();
  });

  it('rejects a bare namespace with no file', () => {
    expect(() => validateCanonicalPath('notes')).toThrow();
    expect(() => validateCanonicalPath('notes/')).toThrow();
  });

  it('normalizes to NFC', () => {
    const nfd = 'notes/cafe\u0301.md';
    expect(validateCanonicalPath(nfd)).toBe('notes/caf\u00e9.md');
  });
});

describe('namespaceOf', () => {
  it('identifies each namespace', () => {
    expect(namespaceOf('notes/x.md')).toBe('notes');
    expect(namespaceOf('instructions/private.md')).toBe('instructions');
    expect(namespaceOf('agents/reviewer/x.md')).toBe('agents');
  });

  it('returns null for an unrecognized namespace', () => {
    expect(namespaceOf('other/x.md')).toBeNull();
  });
});

describe('agentOfAgentsPath', () => {
  it('extracts the agent name', () => {
    expect(agentOfAgentsPath('agents/reviewer/notes.md')).toBe('reviewer');
  });

  it('returns null outside agents namespace', () => {
    expect(agentOfAgentsPath('notes/x.md')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- paths.test.ts`
Expected: FAIL with a module-not-found error for `./paths.js`

- [ ] **Step 3: Implement `paths.ts`**

Create `packages/memory/src/canonical/paths.ts`:

```ts
import { validateTreePath } from '@stack/shared';

export const NAMESPACES = ['notes', 'instructions', 'agents'] as const;
export type Namespace = (typeof NAMESPACES)[number];

export class InvalidCanonicalPathError extends Error {
  constructor(public readonly path: string) {
    super(`Invalid canonical Memory path: ${path}`);
    this.name = 'InvalidCanonicalPathError';
  }
}

export const validateCanonicalPath = (path: string): string => {
  const nfc = path.normalize('NFC');
  let normalized: string;
  try {
    normalized = validateTreePath(nfc);
  } catch {
    throw new InvalidCanonicalPathError(path);
  }
  const segments = normalized.split('/');
  const namespace = segments[0];
  const rest = segments.slice(1);
  if (
    !namespace ||
    !(NAMESPACES as readonly string[]).includes(namespace) ||
    rest.length === 0 ||
    rest.some((segment) => segment.length === 0)
  )
    throw new InvalidCanonicalPathError(path);
  return normalized;
};

export const namespaceOf = (path: string): Namespace | null => {
  const first = path.split('/')[0];
  return (NAMESPACES as readonly string[]).includes(first ?? '')
    ? (first as Namespace)
    : null;
};

export const agentOfAgentsPath = (path: string): string | null => {
  if (namespaceOf(path) !== 'agents') return null;
  const agent = path.split('/')[1];
  return agent && agent.length > 0 ? agent : null;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- paths.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing tests for the domain schema**

Create `packages/memory/src/canonical/domain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_MAIN_SCHEMA_VERSION,
  canonicalDigest,
  canonicalMainManifestSchema,
  type CanonicalMainManifest,
} from './domain.js';

const sha = (n: number) => `sha256:${n.toString().padStart(64, '0')}`;

describe('canonicalMainManifestSchema', () => {
  it('accepts a present document and a tombstone', () => {
    const main = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        {
          projectId: 'prj_0000000000000000000000000',
          documents: [
            {
              path: 'notes/a.md',
              state: 'present',
              contentHash: sha(1),
              importedFrom: 'claude',
              importedAt: '2026-10-22T00:00:00.000Z',
            },
            {
              path: 'notes/b.md',
              state: 'deleted',
              lastContentHash: sha(2),
              deletedAt: '2026-10-22T00:00:00.000Z',
            },
          ],
        },
      ],
    };
    expect(() => canonicalMainManifestSchema.parse(main)).not.toThrow();
  });

  it('rejects a document missing its state-specific fields', () => {
    const main = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        {
          projectId: 'prj_0000000000000000000000000',
          documents: [{ path: 'notes/a.md', state: 'present' }],
        },
      ],
    };
    expect(() => canonicalMainManifestSchema.parse(main)).toThrow();
  });
});

describe('canonicalDigest', () => {
  const docA: CanonicalMainManifest['projects'][0]['documents'][0] = {
    path: 'notes/a.md',
    state: 'present',
    contentHash: sha(1),
    importedFrom: 'claude',
    importedAt: '2026-10-22T00:00:00.000Z',
  };
  const docZ: CanonicalMainManifest['projects'][0]['documents'][0] = {
    path: 'notes/z.md',
    state: 'present',
    contentHash: sha(2),
    importedFrom: 'claude',
    importedAt: '2026-10-22T00:00:00.000Z',
  };

  it('is identical regardless of project/document array order', () => {
    const a: CanonicalMainManifest = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        { projectId: 'prj_b', documents: [docA] },
        { projectId: 'prj_a', documents: [docZ] },
      ],
    };
    const b: CanonicalMainManifest = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        { projectId: 'prj_a', documents: [docZ] },
        { projectId: 'prj_b', documents: [docA] },
      ],
    };
    expect(canonicalDigest(a)).toBe(canonicalDigest(b));
  });

  it('differs when a content hash differs', () => {
    const a: CanonicalMainManifest = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [{ projectId: 'prj_a', documents: [docA] }],
    };
    const b: CanonicalMainManifest = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [
        { projectId: 'prj_a', documents: [{ ...docA, contentHash: sha(9) }] },
      ],
    };
    expect(canonicalDigest(a)).not.toBe(canonicalDigest(b));
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- domain.test.ts`
Expected: FAIL with a module-not-found error for `./domain.js`

- [ ] **Step 7: Implement `domain.ts`**

Create `packages/memory/src/canonical/domain.ts`:

```ts
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { memoryHashSchema } from '../domain.js';
import { PROJECT_ID_PATTERN } from '../project/project-id.js';

export const CANONICAL_MAIN_SCHEMA_VERSION = 2 as const;

export const canonicalImportedFromSchema = z.literal('claude');

export const canonicalDocPresentSchema = z.object({
  path: z.string().min(1),
  state: z.literal('present'),
  contentHash: memoryHashSchema,
  importedFrom: canonicalImportedFromSchema,
  importedAt: z.iso.datetime({ offset: true }),
});
export type CanonicalDocPresent = z.infer<typeof canonicalDocPresentSchema>;

export const canonicalDocDeletedSchema = z.object({
  path: z.string().min(1),
  state: z.literal('deleted'),
  lastContentHash: memoryHashSchema,
  deletedAt: z.iso.datetime({ offset: true }),
});
export type CanonicalDocDeleted = z.infer<typeof canonicalDocDeletedSchema>;

export const canonicalDocSchema = z.discriminatedUnion('state', [
  canonicalDocPresentSchema,
  canonicalDocDeletedSchema,
]);
export type CanonicalDoc = z.infer<typeof canonicalDocSchema>;

export const canonicalProjectMemorySchema = z.object({
  projectId: z.string().regex(PROJECT_ID_PATTERN),
  documents: z.array(canonicalDocSchema),
});
export type CanonicalProjectMemory = z.infer<
  typeof canonicalProjectMemorySchema
>;

export const canonicalMainManifestSchema = z.object({
  schemaVersion: z.literal(CANONICAL_MAIN_SCHEMA_VERSION),
  projects: z.array(canonicalProjectMemorySchema),
});
export type CanonicalMainManifest = z.infer<
  typeof canonicalMainManifestSchema
>;

export const emptyCanonicalMain = (): CanonicalMainManifest => ({
  schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
  projects: [],
});

export const canonicalDigestInput = (main: CanonicalMainManifest): string =>
  JSON.stringify({
    schemaVersion: main.schemaVersion,
    projects: [...main.projects]
      .map((project) => ({
        projectId: project.projectId,
        documents: [...project.documents].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        ),
      }))
      .sort((a, b) =>
        a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0,
      ),
  });

export const canonicalDigest = (main: CanonicalMainManifest): string =>
  `sha256:${createHash('sha256')
    .update(canonicalDigestInput(main))
    .digest('hex')}`;

export const projectMemoryOf = (
  main: CanonicalMainManifest,
  projectId: string,
): CanonicalProjectMemory | undefined =>
  main.projects.find((project) => project.projectId === projectId);

export const documentOf = (
  main: CanonicalMainManifest,
  projectId: string,
  path: string,
): CanonicalDoc | undefined =>
  projectMemoryOf(main, projectId)?.documents.find((doc) => doc.path === path);
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- domain.test.ts paths.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/memory/src/canonical/domain.ts packages/memory/src/canonical/domain.test.ts packages/memory/src/canonical/paths.ts packages/memory/src/canonical/paths.test.ts
git commit -m "feat(memory): add canonical Project Memory domain model and path rules"
```

---

### Task 2: Canonical store I/O (main/base/merge/projections)

**Files:**
- Create: `packages/memory/src/canonical/store.ts`
- Test: `packages/memory/src/canonical/store.test.ts`
- Modify: `packages/core/src/state.ts`

**Interfaces:**
- Consumes: `CanonicalMainManifest`, `canonicalMainManifestSchema`, `emptyCanonicalMain()` from `./domain.js` (Task 1).
- Produces: `canonicalStorePaths(stackHome): { root, main, base, merge, projections(adapterId) }`, `readCanonicalMain(stackHome): Promise<CanonicalMainManifest>`, `writeCanonicalMain(stackHome, main): Promise<void>`, `type CanonicalBase = { generation: number; main: CanonicalMainManifest }`, `readCanonicalBase(stackHome): Promise<CanonicalBase | null>`, `writeCanonicalBase(stackHome, base): Promise<void>`, `type PendingMerge = { basedOnGeneration: number; merged: CanonicalMainManifest; conflicts: MergeConflict[] }` (re-exported type from `./merge.js`, defined there in Task 4 — this task only persists it as `unknown`-shaped JSON via a passed-in schema), `readPendingMerge(stackHome): Promise<PendingMerge | null>`, `writePendingMerge(stackHome, merge): Promise<void>`, `clearPendingMerge(stackHome): Promise<void>`, `type Projection = Record<string, string>` (canonical `path` -> last-synced content hash, scoped by project inside the file), `readProjection(stackHome, adapterId): Promise<ProjectionFile>`, `writeProjection(stackHome, adapterId, file): Promise<void>` where `ProjectionFile = { schemaVersion: 1; projects: Record<string, Record<string, string>> }` (projectId -> path -> hash).

Because `PendingMerge` depends on `MergeConflict` from Task 4 (`merge.ts`), which does not exist yet, this task defines the pending-merge file I/O generically over `z.unknown()` validated by a schema passed at the call site, and Task 4 will supply the real schema. To keep this task fully testable on its own, write the pending-merge round-trip test using a minimal local shape and a locally-defined zod schema (shown in Step 1); Task 9 (`push.ts`) is what actually imports `./merge.js`'s real schema when constructing a `PendingMerge`.

- [ ] **Step 1: Write the failing tests**

Create `packages/memory/src/canonical/store.test.ts`:

```ts
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
    expect(main).toEqual({ schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [] });
  });

  it('round-trips a written manifest', async () => {
    const main = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [{ projectId: 'prj_x', documents: [] }],
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
    const merge = { basedOnGeneration: 5, merged: { a: 1 }, conflicts: [{ b: 2 }] };
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
      projects: { prj_x: { 'notes/a.md': 'sha256:' + '0'.repeat(64) } },
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
    expect(paths.merge).toContain(path.join('memory', 'canonical', 'merge.json'));
    expect(paths.projections('claude')).toContain(
      path.join('memory', 'projections', 'claude.json'),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- canonical/store.test.ts`
Expected: FAIL with a module-not-found error for `./store.js`

- [ ] **Step 3: Implement `store.ts`**

Create `packages/memory/src/canonical/store.ts`:

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { atomicWriteFile } from '../remote/secure-file.js';
import { memoryStorePaths } from '../store.js';
import {
  canonicalMainManifestSchema,
  emptyCanonicalMain,
  type CanonicalMainManifest,
} from './domain.js';

export class CanonicalStoreError extends Error {
  constructor(
    public readonly code: 'main-corrupt' | 'base-corrupt' | 'merge-corrupt' | 'projection-corrupt',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CanonicalStoreError';
  }
}

export const canonicalStorePaths = (stackHome: string) => {
  const root = path.join(memoryStorePaths(stackHome).root, 'canonical');
  const projectionsRoot = path.join(memoryStorePaths(stackHome).root, 'projections');
  return {
    root,
    main: path.join(root, 'main.json'),
    base: path.join(root, 'base.json'),
    merge: path.join(root, 'merge.json'),
    projectionsRoot,
    projections: (adapterId: string) => path.join(projectionsRoot, `${adapterId}.json`),
  };
};

const readJson = async <T>(file: string): Promise<unknown | undefined> => {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(raw) as unknown;
};

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await atomicWriteFile(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
};

export const readCanonicalMain = async (
  stackHome: string,
): Promise<CanonicalMainManifest> => {
  const raw = await readJson(canonicalStorePaths(stackHome).main);
  if (raw === undefined) return emptyCanonicalMain();
  try {
    return canonicalMainManifestSchema.parse(raw);
  } catch (error) {
    throw new CanonicalStoreError(
      'main-corrupt',
      'Canonical Memory manifest is malformed.',
      { cause: error },
    );
  }
};

export const writeCanonicalMain = async (
  stackHome: string,
  main: CanonicalMainManifest,
): Promise<void> =>
  writeJson(canonicalStorePaths(stackHome).main, canonicalMainManifestSchema.parse(main));

export type CanonicalBase = {
  generation: number;
  main: CanonicalMainManifest;
};

const canonicalBaseSchema = z.object({
  generation: z.number().int().nonnegative(),
  main: canonicalMainManifestSchema,
});

export const readCanonicalBase = async (
  stackHome: string,
): Promise<CanonicalBase | null> => {
  const raw = await readJson(canonicalStorePaths(stackHome).base);
  if (raw === undefined) return null;
  try {
    return canonicalBaseSchema.parse(raw);
  } catch (error) {
    throw new CanonicalStoreError('base-corrupt', 'Canonical Memory base is malformed.', {
      cause: error,
    });
  }
};

export const writeCanonicalBase = async (
  stackHome: string,
  base: CanonicalBase,
): Promise<void> =>
  writeJson(canonicalStorePaths(stackHome).base, canonicalBaseSchema.parse(base));

export const readPendingMerge = async <T>(
  stackHome: string,
  schema: z.ZodType<T>,
): Promise<T | null> => {
  const raw = await readJson(canonicalStorePaths(stackHome).merge);
  if (raw === undefined) return null;
  try {
    return schema.parse(raw);
  } catch (error) {
    throw new CanonicalStoreError(
      'merge-corrupt',
      'Pending Memory merge is malformed.',
      { cause: error },
    );
  }
};

export const writePendingMerge = async (
  stackHome: string,
  merge: unknown,
): Promise<void> => writeJson(canonicalStorePaths(stackHome).merge, merge);

export const clearPendingMerge = async (stackHome: string): Promise<void> => {
  const { rm } = await import('node:fs/promises');
  await rm(canonicalStorePaths(stackHome).merge, { force: true });
};

export type ProjectionFile = {
  schemaVersion: 1;
  projects: Record<string, Record<string, string>>;
};

const projectionFileSchema: z.ZodType<ProjectionFile> = z.object({
  schemaVersion: z.literal(1),
  projects: z.record(z.string(), z.record(z.string(), z.string())),
});

export const emptyProjectionFile = (): ProjectionFile => ({
  schemaVersion: 1,
  projects: {},
});

export const readProjection = async (
  stackHome: string,
  adapterId: string,
): Promise<ProjectionFile> => {
  const raw = await readJson(canonicalStorePaths(stackHome).projections(adapterId));
  if (raw === undefined) return emptyProjectionFile();
  try {
    return projectionFileSchema.parse(raw);
  } catch (error) {
    throw new CanonicalStoreError(
      'projection-corrupt',
      `Memory projection for adapter "${adapterId}" is malformed.`,
      { cause: error },
    );
  }
};

export const writeProjection = async (
  stackHome: string,
  adapterId: string,
  file: ProjectionFile,
): Promise<void> =>
  writeJson(
    canonicalStorePaths(stackHome).projections(adapterId),
    projectionFileSchema.parse(file),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- canonical/store.test.ts`
Expected: PASS

- [ ] **Step 5: Exclude the new machine-local files from state/bundle tracking**

Read `packages/core/src/state.ts` around the array documented at line 56 (`STATE_EXCLUDE_PATHS` or equivalent, found by grepping `recovery-state.json` in that file) and add the three new machine-local paths next to the existing Memory entries:

```ts
path.join('memory', 'canonical', 'base.json'), // machine-local merge base
path.join('memory', 'canonical', 'merge.json'), // machine-local pending merge
path.join('memory', 'projections'), // machine-local native/canonical sync state (directory)
```

Leave `path.join('memory', 'canonical', 'main.json')` OUT of this exclusion list — it is portable and travels inside the bundle (Task 7).

- [ ] **Step 6: Run the state test suite to confirm nothing else depends on the exact exclusion list contents**

Run: `pnpm --filter @stack/core test`
Expected: PASS (if an existing test snapshots the full exclusion list, update that snapshot to include the three new entries — do not change its assertion style)

- [ ] **Step 7: Commit**

```bash
git add packages/memory/src/canonical/store.ts packages/memory/src/canonical/store.test.ts packages/core/src/state.ts
git commit -m "feat(memory): add canonical Memory store I/O (main/base/merge/projections)"
```

---

### Task 3: The N/P/C sync engine (pure)

This is the core decision logic from spec section 6 and Appendix A.2. It is pure: it takes three maps (native, projection, canonical) for one project and returns a plan. No file I/O, no adapter calls.

**Files:**
- Create: `packages/memory/src/canonical/sync.ts`
- Test: `packages/memory/src/canonical/sync.test.ts`

**Interfaces:**
- Consumes: `CanonicalDoc`, `CanonicalProjectMemory` from `./domain.js` (Task 1).
- Produces:
  - `type NativeEntry = { path: string; contentHash: string }`
  - `type SyncAction = | { kind: 'none' } | { kind: 'import-edit'; path: string; contentHash: string } | { kind: 'import-delete'; path: string } | { kind: 'materialize-write'; path: string; contentHash: string } | { kind: 'materialize-delete'; path: string } | { kind: 'already-synced'; path: string; contentHash: string } | { kind: 'conflict'; path: string; reason: 'edit-edit' | 'edit-delete' | 'delete-edit' | 'adopt-mismatch' }`
  - `planSync(input: { native: NativeEntry[]; projection: Record<string, string>; canonical: CanonicalDoc[] }): SyncAction[]`

- [ ] **Step 1: Write the failing tests — one per row of the N/P/C table**

Create `packages/memory/src/canonical/sync.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CanonicalDoc } from './domain.js';
import { planSync, type NativeEntry } from './sync.js';

const h = (n: number) => `sha256:${n.toString().padStart(64, '0')}`;
const present = (path: string, n: number): CanonicalDoc => ({
  path,
  state: 'present',
  contentHash: h(n),
  importedFrom: 'claude',
  importedAt: '2026-10-22T00:00:00.000Z',
});
const deleted = (path: string, n: number): CanonicalDoc => ({
  path,
  state: 'deleted',
  lastContentHash: h(n),
  deletedAt: '2026-10-22T00:00:00.000Z',
});
const native = (path: string, n: number): NativeEntry => ({ path, contentHash: h(n) });

describe('planSync', () => {
  it('N=P=C: nothing changed -> no action', () => {
    const actions = planSync({
      native: [native('notes/a.md', 1)],
      projection: { 'notes/a.md': h(1) },
      canonical: [present('notes/a.md', 1)],
    });
    expect(actions).toEqual([{ kind: 'none' }]);
  });

  it('N != P, C = P: a native edit -> import-edit', () => {
    const actions = planSync({
      native: [native('notes/a.md', 2)],
      projection: { 'notes/a.md': h(1) },
      canonical: [present('notes/a.md', 1)],
    });
    expect(actions).toEqual([
      { kind: 'import-edit', path: 'notes/a.md', contentHash: h(2) },
    ]);
  });

  it('N = P, C != P: canonical moved ahead -> materialize-write', () => {
    const actions = planSync({
      native: [native('notes/a.md', 1)],
      projection: { 'notes/a.md': h(1) },
      canonical: [present('notes/a.md', 2)],
    });
    expect(actions).toEqual([
      { kind: 'materialize-write', path: 'notes/a.md', contentHash: h(2) },
    ]);
  });

  it('N != P, C != P, N = C: both reached the same result -> already-synced', () => {
    const actions = planSync({
      native: [native('notes/a.md', 2)],
      projection: { 'notes/a.md': h(1) },
      canonical: [present('notes/a.md', 2)],
    });
    expect(actions).toEqual([
      { kind: 'already-synced', path: 'notes/a.md', contentHash: h(2) },
    ]);
  });

  it('N != P, C != P, N != C: a real conflict (edit-edit)', () => {
    const actions = planSync({
      native: [native('notes/a.md', 2)],
      projection: { 'notes/a.md': h(1) },
      canonical: [present('notes/a.md', 3)],
    });
    expect(actions).toEqual([
      { kind: 'conflict', path: 'notes/a.md', reason: 'edit-edit' },
    ]);
  });

  it('native missing, P present, C unchanged -> import-delete', () => {
    const actions = planSync({
      native: [],
      projection: { 'notes/a.md': h(1) },
      canonical: [present('notes/a.md', 1)],
    });
    expect(actions).toEqual([{ kind: 'import-delete', path: 'notes/a.md' }]);
  });

  it('canonical deleted, native unchanged (N=P) -> materialize-delete', () => {
    const actions = planSync({
      native: [native('notes/a.md', 1)],
      projection: { 'notes/a.md': h(1) },
      canonical: [deleted('notes/a.md', 1)],
    });
    expect(actions).toEqual([{ kind: 'materialize-delete', path: 'notes/a.md' }]);
  });

  it('canonical deleted, native edited (N!=P) -> conflict edit-delete', () => {
    const actions = planSync({
      native: [native('notes/a.md', 2)],
      projection: { 'notes/a.md': h(1) },
      canonical: [deleted('notes/a.md', 1)],
    });
    expect(actions).toEqual([
      { kind: 'conflict', path: 'notes/a.md', reason: 'edit-delete' },
    ]);
  });

  it('native deleted (missing), canonical edited after P -> conflict delete-edit', () => {
    const actions = planSync({
      native: [],
      projection: { 'notes/a.md': h(1) },
      canonical: [present('notes/a.md', 2)],
    });
    expect(actions).toEqual([
      { kind: 'conflict', path: 'notes/a.md', reason: 'delete-edit' },
    ]);
  });

  it('first sighting (no P), native and canonical identical -> already-synced', () => {
    const actions = planSync({
      native: [native('notes/a.md', 1)],
      projection: {},
      canonical: [present('notes/a.md', 1)],
    });
    expect(actions).toEqual([
      { kind: 'already-synced', path: 'notes/a.md', contentHash: h(1) },
    ]);
  });

  it('first sighting (no P), native and canonical differ -> conflict adopt-mismatch', () => {
    const actions = planSync({
      native: [native('notes/a.md', 1)],
      projection: {},
      canonical: [present('notes/a.md', 2)],
    });
    expect(actions).toEqual([
      { kind: 'conflict', path: 'notes/a.md', reason: 'adopt-mismatch' },
    ]);
  });

  it('a brand-new native file with no P and no C -> import-edit', () => {
    const actions = planSync({
      native: [native('notes/new.md', 1)],
      projection: {},
      canonical: [],
    });
    expect(actions).toEqual([
      { kind: 'import-edit', path: 'notes/new.md', contentHash: h(1) },
    ]);
  });

  it('a tombstoned path with no native and no P stays none (already deleted both sides)', () => {
    const actions = planSync({
      native: [],
      projection: {},
      canonical: [deleted('notes/gone.md', 1)],
    });
    expect(actions).toEqual([{ kind: 'none' }]);
  });

  it('tombstone-resurrection guard: a native file byte-identical to a tombstone is never re-imported', () => {
    const actions = planSync({
      native: [native('notes/gone.md', 1)],
      projection: {},
      canonical: [deleted('notes/gone.md', 1)],
    });
    // Not import-edit. The native copy matches what was deleted, so it is ignored.
    expect(actions).toEqual([{ kind: 'none' }]);
  });

  it('tombstone-resurrection guard does not block genuinely new content at the same path', () => {
    const actions = planSync({
      native: [native('notes/gone.md', 2)],
      projection: {},
      canonical: [deleted('notes/gone.md', 1)],
    });
    expect(actions).toEqual([
      { kind: 'import-edit', path: 'notes/gone.md', contentHash: h(2) },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- canonical/sync.test.ts`
Expected: FAIL with a module-not-found error for `./sync.js`

- [ ] **Step 3: Implement `sync.ts`**

Create `packages/memory/src/canonical/sync.ts`:

```ts
import type { CanonicalDoc } from './domain.js';

export type NativeEntry = { path: string; contentHash: string };

export type SyncAction =
  | { kind: 'none' }
  | { kind: 'import-edit'; path: string; contentHash: string }
  | { kind: 'import-delete'; path: string }
  | { kind: 'materialize-write'; path: string; contentHash: string }
  | { kind: 'materialize-delete'; path: string }
  | { kind: 'already-synced'; path: string; contentHash: string }
  | {
      kind: 'conflict';
      path: string;
      reason: 'edit-edit' | 'edit-delete' | 'delete-edit' | 'adopt-mismatch';
    };

const canonicalContentHash = (doc: CanonicalDoc | undefined): string | undefined =>
  doc === undefined
    ? undefined
    : doc.state === 'present'
      ? doc.contentHash
      : undefined; // deleted carries no "current" content

const canonicalTombstoneHash = (doc: CanonicalDoc | undefined): string | undefined =>
  doc?.state === 'deleted' ? doc.lastContentHash : undefined;

/**
 * Plan sync actions for one project's documents, given its native entries, its
 * last-synced projection (canonical path -> hash), and its canonical documents.
 * Pure: no I/O, no adapter awareness. One action per path that appears on any
 * side. See `docs/superpowers/specs/2026-10-22-stak-native-project-memory-design.md`
 * section 6 and Appendix A.2 for the table this implements.
 */
export const planSync = (input: {
  native: NativeEntry[];
  projection: Record<string, string>;
  canonical: CanonicalDoc[];
}): SyncAction[] => {
  const nativeByPath = new Map(input.native.map((entry) => [entry.path, entry.contentHash]));
  const canonicalByPath = new Map(input.canonical.map((doc) => [doc.path, doc]));
  const paths = new Set<string>([
    ...nativeByPath.keys(),
    ...Object.keys(input.projection),
    ...canonicalByPath.keys(),
  ]);

  const actions: SyncAction[] = [];
  for (const path of [...paths].sort()) {
    const N = nativeByPath.get(path); // undefined = native file absent
    const P = input.projection[path]; // undefined = never synced
    const canonicalDoc = canonicalByPath.get(path);
    const C = canonicalContentHash(canonicalDoc); // undefined = canonical absent or deleted
    const tombstone = canonicalTombstoneHash(canonicalDoc);

    // Tombstone-resurrection guard: a native file whose content exactly matches
    // what was deleted is never treated as a new import. Scoped to P === undefined
    // (first sighting) ONLY — a P-defined path with a tombstone always falls to the
    // P-defined branch below, where `cMatchesP` (plain `C === P`) is false (C is
    // undefined, P is a real hash), correctly producing materialize-delete /
    // conflict rather than resurrecting anything; the resurrection case that
    // actually needs blocking is the no-history one below.
    if (
      P === undefined &&
      tombstone !== undefined &&
      N !== undefined &&
      N === tombstone &&
      C === undefined
    ) {
      actions.push({ kind: 'none' });
      continue;
    }

    if (P === undefined) {
      // First sighting: nothing synced yet for this path.
      if (N === undefined && C === undefined) {
        actions.push({ kind: 'none' });
      } else if (N !== undefined && C === undefined) {
        // The resurrection guard above already excluded N === tombstone; any other
        // native-only content here is genuinely new and must import, EVEN when a
        // tombstone exists for this path at a different hash.
        actions.push({ kind: 'import-edit', path, contentHash: N });
      } else if (N === undefined && C !== undefined) {
        actions.push({ kind: 'materialize-write', path, contentHash: C });
      } else if (N !== undefined && C !== undefined) {
        if (N === C) actions.push({ kind: 'already-synced', path, contentHash: N });
        else actions.push({ kind: 'conflict', path, reason: 'adopt-mismatch' });
      } else {
        actions.push({ kind: 'none' });
      }
      continue;
    }

    const nMatchesP = N === P;
    // Plain equality — NOT `C === P || (C === undefined && tombstone === P)`. That
    // extra clause looks plausible (P === tombstone happens right after a canonical
    // delete arrives, before this machine's own delete is synced) but is wrong: it
    // treats "canonical was just deleted" as "canonical hasn't changed," which
    // either silently loses the delete (native unchanged -> 'none' instead of
    // materialize-delete) or lets a native edit silently override a canonical
    // delete (both changed -> import-edit instead of conflict edit-delete).
    const cMatchesP = C === P;

    if (nMatchesP && cMatchesP) {
      actions.push({ kind: 'none' });
    } else if (!nMatchesP && cMatchesP) {
      // Native changed, canonical did not.
      if (N === undefined) actions.push({ kind: 'import-delete', path });
      else actions.push({ kind: 'import-edit', path, contentHash: N });
    } else if (nMatchesP && !cMatchesP) {
      // Canonical changed, native did not.
      if (C === undefined) actions.push({ kind: 'materialize-delete', path });
      else actions.push({ kind: 'materialize-write', path, contentHash: C });
    } else {
      // Both changed since the last sync.
      if (N !== undefined && C !== undefined && N === C) {
        actions.push({ kind: 'already-synced', path, contentHash: N });
      } else if (N !== undefined && C !== undefined) {
        actions.push({ kind: 'conflict', path, reason: 'edit-edit' });
      } else if (N === undefined && C !== undefined) {
        actions.push({ kind: 'conflict', path, reason: 'delete-edit' });
      } else if (N !== undefined && C === undefined) {
        actions.push({ kind: 'conflict', path, reason: 'edit-delete' });
      } else {
        // Both deleted since the last sync: they already agree.
        actions.push({ kind: 'none' });
      }
    }
  }
  return actions;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- canonical/sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/canonical/sync.ts packages/memory/src/canonical/sync.test.ts
git commit -m "feat(memory): add the N/P/C Memory sync decision engine"
```

---

### Task 4: Three-way merge engine and keep-both naming

**Files:**
- Create: `packages/memory/src/canonical/merge.ts`
- Test: `packages/memory/src/canonical/merge.test.ts`

**Interfaces:**
- Consumes: `CanonicalDoc`, `CanonicalMainManifest`, `CanonicalProjectMemory`, `projectMemoryOf`, `documentOf` from `./domain.js` (Task 1).
- Produces: `type MergeConflict = { projectId: string; path: string; reason: 'edit-edit' | 'edit-delete' | 'delete-delete' }` (`'delete-delete'` covers both sides having no live content — deleted, or an absent entry with no tombstone at all — with differing history; `'edit-edit'` requires BOTH sides to actually be `present`), `mergeConflictSchema` (zod, for persisting inside `PendingMerge`), `type MergeOutcome = { merged: CanonicalMainManifest; conflicts: MergeConflict[] }`, `mergeCanonical(base: CanonicalMainManifest, local: CanonicalMainManifest, remote: CanonicalMainManifest): MergeOutcome`, `keepBothPath(originalPath: string, localContentHash: string, isTaken: (candidate: string) => boolean): string`.

- [ ] **Step 1: Write the failing tests**

Create `packages/memory/src/canonical/merge.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CANONICAL_MAIN_SCHEMA_VERSION, type CanonicalDoc, type CanonicalMainManifest } from './domain.js';
import { keepBothPath, mergeCanonical } from './merge.js';

const h = (n: number) => `sha256:${n.toString().padStart(64, '0')}`;
const present = (path: string, n: number): CanonicalDoc => ({
  path,
  state: 'present',
  contentHash: h(n),
  importedFrom: 'claude',
  importedAt: '2026-10-22T00:00:00.000Z',
});
const deleted = (path: string, n: number): CanonicalDoc => ({
  path,
  state: 'deleted',
  lastContentHash: h(n),
  deletedAt: '2026-10-22T00:00:00.000Z',
});
const manifest = (docs: CanonicalDoc[]): CanonicalMainManifest => ({
  schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
  projects: [{ projectId: 'prj_x', documents: docs }],
});

describe('mergeCanonical', () => {
  it('merge(B,B,R) = R: only remote changed', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 1)]);
    const remote = manifest([present('notes/a.md', 2)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.projects[0]!.documents).toEqual([present('notes/a.md', 2)]);
  });

  it('merge(B,L,B) = L: only local changed', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 2)]);
    const remote = manifest([present('notes/a.md', 1)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.projects[0]!.documents).toEqual([present('notes/a.md', 2)]);
  });

  it('merge(B,X,X) = X: identical changes on both sides agree, no conflict', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 2)]);
    const remote = manifest([present('notes/a.md', 2)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.projects[0]!.documents).toEqual([present('notes/a.md', 2)]);
  });

  it('identical deletes on both sides agree, no conflict', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([deleted('notes/a.md', 1)]);
    const remote = manifest([deleted('notes/a.md', 1)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.projects[0]!.documents).toEqual([deleted('notes/a.md', 1)]);
  });

  it('different edits on both sides conflict and are excluded from the merge result', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 2)]);
    const remote = manifest([present('notes/a.md', 3)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([{ projectId: 'prj_x', path: 'notes/a.md', reason: 'edit-edit' }]);
    expect(merged.projects[0]!.documents).toEqual([]);
  });

  it('edit on one side, delete on the other conflicts', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([present('notes/a.md', 2)]);
    const remote = manifest([deleted('notes/a.md', 1)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([{ projectId: 'prj_x', path: 'notes/a.md', reason: 'edit-delete' }]);
    expect(merged.projects[0]!.documents).toEqual([]);
  });

  it('delete vs delete with different history conflicts as delete-delete, not edit-delete', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local = manifest([deleted('notes/a.md', 1)]);
    const remote = manifest([deleted('notes/a.md', 2)]); // remote edited to v2, then deleted
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([{ projectId: 'prj_x', path: 'notes/a.md', reason: 'delete-delete' }]);
    expect(merged.projects[0]!.documents).toEqual([]);
  });

  it('an entry absent on one side (no tombstone at all) vs present on the other conflicts as edit-delete', () => {
    const base = manifest([present('notes/a.md', 1)]);
    const local: CanonicalMainManifest = { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [{ projectId: 'prj_x', documents: [] }] };
    const remote = manifest([present('notes/a.md', 2)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([{ projectId: 'prj_x', path: 'notes/a.md', reason: 'edit-delete' }]);
    expect(merged.projects[0]!.documents).toEqual([]);
  });

  it('a brand-new document added only on one side is carried over with no conflict', () => {
    const base = manifest([]);
    const local = manifest([present('notes/new.md', 1)]);
    const remote = manifest([]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.projects[0]!.documents).toEqual([present('notes/new.md', 1)]);
  });

  it('a project absent from base/local but present in remote is carried over', () => {
    const base: CanonicalMainManifest = { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [] };
    const local: CanonicalMainManifest = { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [] };
    const remote = manifest([present('notes/a.md', 1)]);
    const { merged, conflicts } = mergeCanonical(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.projects.find((p) => p.projectId === 'prj_x')?.documents).toEqual([
      present('notes/a.md', 1),
    ]);
  });
});

describe('keepBothPath', () => {
  it('builds <stem>.conflict-<12-hex>.<ext> from the local content hash', () => {
    const hash = `sha256:${'a'.repeat(64)}`;
    expect(keepBothPath('notes/auth.md', hash, () => false)).toBe(
      'notes/auth.conflict-aaaaaaaaaaaa.md',
    );
  });

  it('is deterministic for the same path and hash', () => {
    const hash = `sha256:${'b'.repeat(64)}`;
    const a = keepBothPath('notes/x.md', hash, () => false);
    const b = keepBothPath('notes/x.md', hash, () => false);
    expect(a).toBe(b);
  });

  it('extends to 16 hex characters, then the full hash, on collision', () => {
    const hash = `sha256:${'c'.repeat(64)}`;
    const twelve = 'notes/x.conflict-cccccccccccc.md';
    const sixteen = 'notes/x.conflict-cccccccccccccccc.md';
    const full = `notes/x.conflict-${'c'.repeat(64)}.md`;
    const isTaken = (candidate: string) => candidate === twelve || candidate === sixteen;
    expect(keepBothPath('notes/x.md', hash, isTaken)).toBe(full);
  });

  it('handles a path with no extension', () => {
    const hash = `sha256:${'d'.repeat(64)}`;
    expect(keepBothPath('notes/README', hash, () => false)).toBe(
      'notes/README.conflict-dddddddddddd',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- canonical/merge.test.ts`
Expected: FAIL with a module-not-found error for `./merge.js`

- [ ] **Step 3: Implement `merge.ts`**

Create `packages/memory/src/canonical/merge.ts`:

```ts
import { z } from 'zod';

import {
  CANONICAL_MAIN_SCHEMA_VERSION,
  type CanonicalDoc,
  type CanonicalMainManifest,
  type CanonicalProjectMemory,
} from './domain.js';

export type MergeConflict = {
  projectId: string;
  path: string;
  reason: 'edit-edit' | 'edit-delete' | 'delete-delete';
};

export const mergeConflictSchema = z.object({
  projectId: z.string(),
  path: z.string(),
  reason: z.enum(['edit-edit', 'edit-delete', 'delete-delete']),
});

export type MergeOutcome = {
  merged: CanonicalMainManifest;
  conflicts: MergeConflict[];
};

const docsByPath = (project: CanonicalProjectMemory | undefined): Map<string, CanonicalDoc> =>
  new Map((project?.documents ?? []).map((doc) => [doc.path, doc]));

const sameDoc = (a: CanonicalDoc | undefined, b: CanonicalDoc | undefined): boolean => {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.state !== b.state) return false;
  return a.state === 'present' && b.state === 'present'
    ? a.contentHash === b.contentHash
    : a.state === 'deleted' && b.state === 'deleted'
      ? a.lastContentHash === b.lastContentHash
      : false;
};

/**
 * Three-way merge of one project's documents. `base` is what this machine last
 * synced with Cloud; `local` is this machine's current canonical state; `remote`
 * is Cloud's current latest. A document changed only on one side since `base` is
 * taken from that side; changed identically on both sides agrees; changed
 * differently (or edited on one side and deleted on the other) is a conflict and
 * is OMITTED from `merged` (never guessed).
 */
const mergeProject = (
  projectId: string,
  base: CanonicalProjectMemory | undefined,
  local: CanonicalProjectMemory | undefined,
  remote: CanonicalProjectMemory | undefined,
): { documents: CanonicalDoc[]; conflicts: MergeConflict[] } => {
  const baseDocs = docsByPath(base);
  const localDocs = docsByPath(local);
  const remoteDocs = docsByPath(remote);
  const paths = new Set<string>([...baseDocs.keys(), ...localDocs.keys(), ...remoteDocs.keys()]);

  const documents: CanonicalDoc[] = [];
  const conflicts: MergeConflict[] = [];
  for (const path of [...paths].sort()) {
    const B = baseDocs.get(path);
    const L = localDocs.get(path);
    const R = remoteDocs.get(path);
    const localChanged = !sameDoc(B, L);
    const remoteChanged = !sameDoc(B, R);

    if (!localChanged && !remoteChanged) {
      if (B) documents.push(B);
      continue;
    }
    if (localChanged && !remoteChanged) {
      if (L) documents.push(L);
      continue;
    }
    if (!localChanged && remoteChanged) {
      if (R) documents.push(R);
      continue;
    }
    // Both changed since base.
    if (sameDoc(L, R)) {
      if (L) documents.push(L);
      continue;
    }
    // "Gone" covers both an explicit tombstone and an entry that is simply absent
    // (no `CanonicalDoc` at all for this path on that side) — both mean "no live
    // content here," and `'edit-edit'` must require BOTH sides to be genuinely
    // `present`, not just "not provably deleted."
    const isGone = (doc: CanonicalDoc | undefined): boolean =>
      doc === undefined || doc.state === 'deleted';
    const reason: MergeConflict['reason'] = isGone(L) && isGone(R)
      ? 'delete-delete'
      : isGone(L) || isGone(R)
        ? 'edit-delete'
        : 'edit-edit';
    conflicts.push({ projectId, path, reason });
    // Conflicted documents are omitted from `merged` entirely until resolved.
  }
  return { documents, conflicts };
};

export const mergeCanonical = (
  base: CanonicalMainManifest,
  local: CanonicalMainManifest,
  remote: CanonicalMainManifest,
): MergeOutcome => {
  const projectIds = new Set<string>([
    ...base.projects.map((p) => p.projectId),
    ...local.projects.map((p) => p.projectId),
    ...remote.projects.map((p) => p.projectId),
  ]);
  const projects: CanonicalProjectMemory[] = [];
  const conflicts: MergeConflict[] = [];
  for (const projectId of [...projectIds].sort()) {
    const result = mergeProject(
      projectId,
      base.projects.find((p) => p.projectId === projectId),
      local.projects.find((p) => p.projectId === projectId),
      remote.projects.find((p) => p.projectId === projectId),
    );
    projects.push({ projectId, documents: result.documents });
    conflicts.push(...result.conflicts);
  }
  return {
    merged: { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects },
    conflicts,
  };
};

/**
 * Deterministic "keep both" path for a local document kept alongside Cloud's
 * version of the same path. The suffix comes from the LOCAL version's content
 * hash so any machine resolving the same conflict picks the same name. Starts at
 * 12 hex characters, extends to 16 then the full hash only on an actual collision
 * (checked via `isTaken`, which the caller wires to "does this path already exist
 * in canonical/native/other pending resolutions").
 */
export const keepBothPath = (
  originalPath: string,
  localContentHash: string,
  isTaken: (candidate: string) => boolean,
): string => {
  const hex = localContentHash.replace(/^sha256:/, '');
  const lastSlash = originalPath.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : originalPath.slice(0, lastSlash + 1);
  const base = lastSlash === -1 ? originalPath : originalPath.slice(lastSlash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot <= 0 ? base : base.slice(0, dot);
  const ext = dot <= 0 ? '' : base.slice(dot); // includes leading "."
  for (const length of [12, 16, hex.length]) {
    const candidate = `${dir}${stem}.conflict-${hex.slice(0, length)}${ext}`;
    if (!isTaken(candidate)) return candidate;
  }
  return `${dir}${stem}.conflict-${hex}${ext}`;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- canonical/merge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/canonical/merge.ts packages/memory/src/canonical/merge.test.ts
git commit -m "feat(memory): add three-way canonical Memory merge and keep-both naming"
```

---

### Task 5: Claude project adapter (scan + write)

Reuses `discoverClaudeMemory` (`packages/memory/src/claude-adapter.ts`) for the hard part — matching every Claude folder (including ones left behind by a moved project) to a project identity — rather than re-implementing it. This adapter only maps the already-discovered items onto canonical paths and writes canonical documents back to the ONE currently-bound Claude location.

**Files:**
- Create: `packages/memory/src/canonical/claude-project-adapter.ts`
- Test: `packages/memory/src/canonical/claude-project-adapter.test.ts`

**Interfaces:**
- Consumes: `discoverClaudeMemory`, `type ClaudeMemoryDiscoveryOptions`, `type DiscoveredMemoryItem` from `../claude-adapter.js`; `validateCanonicalPath`, `namespaceOf` from `./paths.js` (Task 1); `assertPathWithin` from `@stack/shared`; `atomicWriteFile` from `../remote/secure-file.js`.
- Produces:
  - `type BoundProject = { projectId: string; dir: string; gitRemote?: string }`
  - `type NativeDoc = { canonicalPath: string; contentHash: string; bytes: Uint8Array }`
  - `type SourceConflict = { canonicalPath: string }` (two Claude folders for this project disagree on content at the same canonical path — a different, narrower conflict than the N/P/C merge conflicts in `sync.ts`; surfaced, never auto-resolved, matching today's `reconcileNativeWithStagedMemory` behavior)
  - `type ScanResult = { docs: NativeDoc[]; sourceConflicts: SourceConflict[] }`
  - `type MaterializeOp = { kind: 'write'; canonicalPath: string; bytes: Uint8Array } | { kind: 'delete'; canonicalPath: string }`
  - `type WriteResult = { written: string[]; deleted: string[] }`
  - `scanClaudeProject(project: BoundProject, options: ClaudeMemoryDiscoveryOptions & { resolveProjectId(item: DiscoveredMemoryItem): string | undefined }): Promise<ScanResult>`
  - `writeClaudeProject(project: BoundProject, ops: MaterializeOp[]): Promise<WriteResult>`
  - `claudeCanonicalPathOf(item: DiscoveredMemoryItem): string | null` (maps one discovered item to a canonical path, or null if it is out of scope — e.g. global items)
  - `claudeNativeTargetOf(project: BoundProject, canonicalPath: string): string | null` (the inverse mapping, for writing)

`resolveProjectId` is injected rather than imported from `@stack/cli`'s `canonical-identity.ts`, because `@stack/memory` cannot depend on `@stack/cli` (dependency direction). Task 11 wires the real `resolveCanonicalProjectId` in when calling this from the CLI package.

- [ ] **Step 1: Write the failing tests**

Create `packages/memory/src/canonical/claude-project-adapter.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashBytes } from '../store.js';
import {
  claudeCanonicalPathOf,
  claudeNativeTargetOf,
  scanClaudeProject,
  writeClaudeProject,
} from './claude-project-adapter.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stak-canonical-claude-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))),
);

const write = async (file: string, body: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
};

describe('scanClaudeProject', () => {
  it('maps auto-memory, project agent-memory, and CLAUDE.local.md to canonical paths', async () => {
    const root = await temp();
    const claudeHome = path.join(root, '.claude');
    const projectDir = path.join(root, 'proj');
    const key = 'D--proj'; // simplified encoding for this fixture
    await write(path.join(claudeHome, 'projects', key, 'memory', 'MEMORY.md'), 'hello');
    await write(
      path.join(projectDir, '.claude', 'agent-memory', 'reviewer', 'notes.md'),
      'agent notes',
    );
    await write(path.join(projectDir, 'CLAUDE.local.md'), 'private');

    const result = await scanClaudeProject(
      { projectId: 'prj_x', dir: projectDir },
      {
        claudeHome,
        projects: [{ dir: projectDir }],
        resolveProjectId: () => 'prj_x',
      },
    );

    expect(result.sourceConflicts).toEqual([]);
    const byPath = new Map(result.docs.map((d) => [d.canonicalPath, d]));
    expect(byPath.get('notes/MEMORY.md')?.bytes.toString()).toBe('hello');
    expect(byPath.get('agents/reviewer/notes.md')?.bytes.toString()).toBe('agent notes');
    expect(byPath.get('instructions/private.md')?.bytes.toString()).toBe('private');
  });

  it('omits items whose resolved project id does not match', async () => {
    const root = await temp();
    const claudeHome = path.join(root, '.claude');
    const projectDir = path.join(root, 'proj');
    await write(path.join(projectDir, 'CLAUDE.local.md'), 'private');

    const result = await scanClaudeProject(
      { projectId: 'prj_x', dir: projectDir },
      {
        claudeHome,
        projects: [{ dir: projectDir }],
        resolveProjectId: () => 'prj_other',
      },
    );
    expect(result.docs).toEqual([]);
  });

  it('reports a source conflict when two matched Claude folders disagree, and omits that path', async () => {
    const root = await temp();
    const claudeHome = path.join(root, '.claude');
    const projectDir = path.join(root, 'proj');
    // Two auto-memory folders both matched (same gitRemote) with different content
    // at the same relative file — simulate via gitRemoteOf resolving both to the
    // same identity while `projects` only lists the current one; the second is a
    // leftover folder discovered independently by discoverClaudeMemory's own
    // reconstruction path. For this unit test we instead directly construct the
    // ambiguity by giving two DIFFERENT vendor keys both an identical gitRemote so
    // discoverClaudeMemory resolves them to the SAME git identity.
    await write(path.join(claudeHome, 'projects', 'key-old', 'memory', 'a.md'), 'old');
    await write(path.join(claudeHome, 'projects', 'key-new', 'memory', 'a.md'), 'new');

    const result = await scanClaudeProject(
      { projectId: 'prj_x', dir: projectDir },
      {
        claudeHome,
        projects: [{ dir: projectDir, gitRemote: 'git@github.com:acme/widgets.git' }],
        gitRemoteOf: async () => 'git@github.com:acme/widgets.git',
        isDirectory: async () => true,
        resolveProjectId: () => 'prj_x',
      },
    );
    expect(result.sourceConflicts).toEqual([{ canonicalPath: 'notes/a.md' }]);
    expect(result.docs.find((d) => d.canonicalPath === 'notes/a.md')).toBeUndefined();
  });
});

describe('path mapping', () => {
  it('maps canonical paths to Claude native targets and back', () => {
    const project = { projectId: 'prj_x', dir: path.join('C:', 'work', 'proj') };
    expect(claudeNativeTargetOf(project, 'instructions/private.md')).toBe(
      path.join(project.dir, 'CLAUDE.local.md'),
    );
    expect(claudeNativeTargetOf(project, 'agents/reviewer/notes.md')).toBe(
      path.join(project.dir, '.claude', 'agent-memory', 'reviewer', 'notes.md'),
    );
  });

  it('rejects an out-of-namespace canonical path', () => {
    expect(() => claudeNativeTargetOf({ projectId: 'prj_x', dir: '/x' }, 'other/a.md')).toThrow();
  });
});

describe('writeClaudeProject', () => {
  it('writes and deletes native files for the bound project only', async () => {
    const root = await temp();
    const projectDir = path.join(root, 'proj');
    await writeClaudeProject(
      { projectId: 'prj_x', dir: projectDir },
      [
        { kind: 'write', canonicalPath: 'instructions/private.md', bytes: Buffer.from('p') },
        { kind: 'write', canonicalPath: 'notes/a.md', bytes: Buffer.from('n') },
      ],
    );
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path.join(projectDir, 'CLAUDE.local.md'), 'utf8')).toBe('p');

    await writeClaudeProject({ projectId: 'prj_x', dir: projectDir }, [
      { kind: 'delete', canonicalPath: 'instructions/private.md' },
    ]);
    await expect(readFile(path.join(projectDir, 'CLAUDE.local.md'), 'utf8')).rejects.toThrow();
  });
});
```

Note: `notes/<rel>` native targets write under `<claudeHome>/projects/<encodeClaudeProjectKey(dir)>/memory/<rel>` — a `claudeHome` is required for `notes/` writes, so `writeClaudeProject`'s signature takes an optional `claudeHome` (defaulting to `~/.claude`) alongside `project`/`ops`; add this parameter to the signature above and to every call in the tests above that writes a `notes/` path (none of the Step 1 tests do, so no test changes needed, but note it for Step 3's implementation and for Task 10's integration).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- canonical/claude-project-adapter.test.ts`
Expected: FAIL with a module-not-found error for `./claude-project-adapter.js`

- [ ] **Step 3: Implement `claude-project-adapter.ts`**

Create `packages/memory/src/canonical/claude-project-adapter.ts`:

```ts
import { lstat, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assertPathWithin, PathFenceError } from '@stack/shared';

import {
  discoverClaudeMemory,
  type ClaudeMemoryDiscoveryOptions,
  type DiscoveredMemoryItem,
} from '../claude-adapter.js';
import { hashBytes } from '../store.js';
import { atomicWriteFile } from '../remote/secure-file.js';
import { encodeClaudeProjectKey } from '../project-identity.js';
import { namespaceOf, validateCanonicalPath } from './paths.js';

export type BoundProject = { projectId: string; dir: string; gitRemote?: string };

export type NativeDoc = { canonicalPath: string; contentHash: string; bytes: Uint8Array };
export type SourceConflict = { canonicalPath: string };
export type ScanResult = { docs: NativeDoc[]; sourceConflicts: SourceConflict[] };

export type MaterializeOp =
  | { kind: 'write'; canonicalPath: string; bytes: Uint8Array }
  | { kind: 'delete'; canonicalPath: string };
export type WriteResult = { written: string[]; deleted: string[] };

/** Maps one discovered Claude item to its canonical path, or null if out of scope
 * (global items — `user-instructions` and global `agent-memory` — stay in the v1
 * store per spec section 3). */
export const claudeCanonicalPathOf = (item: DiscoveredMemoryItem): string | null => {
  if (item.scope !== 'project') return null;
  switch (item.kind) {
    case 'auto-memory':
      return validateCanonicalPath(`notes/${item.restoreTarget.relativePath}`);
    case 'agent-memory':
      // restoreTarget.relativePath is `.claude/agent-memory/<agent>/<rest>` for a
      // project-scoped item (see claude-adapter.ts section 4).
      return validateCanonicalPath(
        `agents/${item.restoreTarget.relativePath.replace(/^\.claude\/agent-memory\//, '')}`,
      );
    case 'project-private-instructions':
      return validateCanonicalPath('instructions/private.md');
    default:
      return null;
  }
};

/** The inverse mapping: a canonical path to the native Claude file for a bound
 * project. `claudeHome` is required to resolve `notes/` paths. */
export const claudeNativeTargetOf = (
  project: BoundProject,
  canonicalPath: string,
  claudeHome: string = path.join(os.homedir(), '.claude'),
): string => {
  const validated = validateCanonicalPath(canonicalPath);
  const namespace = namespaceOf(validated);
  const rest = validated.slice(namespace!.length + 1);
  if (namespace === 'notes') {
    const key = encodeClaudeProjectKey(path.resolve(project.dir));
    return path.join(claudeHome, 'projects', key, 'memory', rest);
  }
  if (namespace === 'agents') return path.join(project.dir, '.claude', 'agent-memory', rest);
  if (namespace === 'instructions' && rest === 'private.md')
    return path.join(project.dir, 'CLAUDE.local.md');
  throw new Error(`No native Claude target for canonical path: ${canonicalPath}`);
};

/**
 * Scan every Claude location that resolves to `project.projectId` — reusing
 * `discoverClaudeMemory`'s own moved-folder matching (gitRemote/isDirectory) — and
 * map each item onto a canonical path. When several matched folders disagree on
 * content at the same canonical path, that path is reported as a `SourceConflict`
 * and OMITTED from `docs` (fail closed, same rule as `reconcileNativeWithStagedMemory`).
 */
export const scanClaudeProject = async (
  project: BoundProject,
  options: ClaudeMemoryDiscoveryOptions & {
    resolveProjectId(item: DiscoveredMemoryItem): string | undefined;
  },
): Promise<ScanResult> => {
  const items = await discoverClaudeMemory(options);
  const matched = items.filter((item) => options.resolveProjectId(item) === project.projectId);

  const byPath = new Map<string, DiscoveredMemoryItem[]>();
  for (const item of matched) {
    const canonicalPath = claudeCanonicalPathOf(item);
    if (!canonicalPath) continue;
    const group = byPath.get(canonicalPath);
    if (group) group.push(item);
    else byPath.set(canonicalPath, [item]);
  }

  const docs: NativeDoc[] = [];
  const sourceConflicts: SourceConflict[] = [];
  for (const [canonicalPath, group] of byPath) {
    const hashes = new Set(group.map((item) => item.contentHash));
    if (hashes.size > 1) {
      sourceConflicts.push({ canonicalPath });
      continue;
    }
    const chosen = group[0]!;
    const bytes = await readFile(chosen.source.path);
    docs.push({ canonicalPath, contentHash: hashBytes(bytes), bytes });
  }
  return { docs, sourceConflicts: sourceConflicts.sort((a, b) => (a.canonicalPath < b.canonicalPath ? -1 : 1)) };
};

/**
 * Refuse a narrowed owned root whose path, from `anchor` down to `root`, passes
 * through a symlinked directory segment. `assertPathWithin` itself realpath-
 * canonicalizes `root`, so a symlinked root (or an ancestor of it) would silently
 * redirect the fence to wherever that symlink points — this check closes that gap.
 * A segment that does not exist yet (nothing created there so far) is not a
 * symlink and is safe to pass through. `anchor` (`project.dir`/`claudeHome`) is
 * trusted as given — it is a user-confirmed `stak project map` binding or the
 * user's own home directory, never something a cloned repo's content controls.
 */
const assertRootHasNoSymlinkSegments = async (anchor: string, root: string): Promise<void> => {
  const relative = path.relative(anchor, root);
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  let current = anchor;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new PathFenceError(); // same error type assertPathWithin itself throws
  }
};

/** Write/delete native Claude files for the CURRENT bound location only — never
 * to any historical/leftover folder. Caller (the pull/materialize orchestrator,
 * Task 10) is responsible for only passing ops the sync engine already approved.
 * The owned root for `notes/`/`agents/` is narrowed to the SPECIFIC memory
 * subdirectory (not the whole `project.dir`/project-key directory) so a symlink
 * at the first attacker-influenced segment underneath it (e.g.
 * `.claude/agent-memory/<agent>` pointing at `../../.git/hooks`) cannot
 * realpath-escape into a location that still reads as "within project.dir". The
 * narrowed root itself is then checked by `assertRootHasNoSymlinkSegments`, since
 * `assertPathWithin` canonicalizes the ROOT too — without that second check, a
 * symlink planted AT `.claude` or `.claude/agent-memory` itself would redirect the
 * fence to wherever it points, which is worse than not narrowing the root at all.
 * `instructions/`'s root stays `project.dir` (no nested, attacker-influenced
 * segment exists there — the target is always exactly `project.dir/CLAUDE.local.md`,
 * and a symlinked `CLAUDE.local.md` itself is replaced, not written through, by
 * `atomicWriteFile`'s rename and by `rm`'s unlink). */
export const writeClaudeProject = async (
  project: BoundProject,
  ops: MaterializeOp[],
  claudeHome: string = path.join(os.homedir(), '.claude'),
): Promise<WriteResult> => {
  const written: string[] = [];
  const deleted: string[] = [];
  for (const op of ops) {
    const target = claudeNativeTargetOf(project, op.canonicalPath, claudeHome);
    const namespace = namespaceOf(op.canonicalPath);
    const ownedRoot =
      namespace === 'notes'
        ? path.join(claudeHome, 'projects', encodeClaudeProjectKey(path.resolve(project.dir)), 'memory')
        : namespace === 'agents'
          ? path.join(project.dir, '.claude', 'agent-memory')
          : project.dir;
    if (namespace === 'notes') await assertRootHasNoSymlinkSegments(claudeHome, ownedRoot);
    else if (namespace === 'agents') await assertRootHasNoSymlinkSegments(project.dir, ownedRoot);
    await assertPathWithin({ ownedRoot, proposedPath: target, allowRoot: true });
    if (op.kind === 'write') {
      await atomicWriteFile(target, op.bytes);
      written.push(op.canonicalPath);
    } else {
      await rm(target, { force: true });
      deleted.push(op.canonicalPath);
    }
  }
  return { written, deleted };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- canonical/claude-project-adapter.test.ts`
Expected: PASS

If the "source conflict" test fails because `discoverClaudeMemory` does not resolve two differently-keyed vendor folders to the same identity without a passed `projects` candidate matching one of them exactly, adjust the test fixture to match `discoverClaudeMemory`'s actual matching rules (re-read `packages/memory/src/claude-adapter.ts` lines 190-247) rather than changing `scanClaudeProject`'s logic — the dedup-by-hash grouping in Step 3 is correct per spec; only the test's fixture setup may need adjusting to actually produce two matched items.

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/canonical/claude-project-adapter.ts packages/memory/src/canonical/claude-project-adapter.test.ts
git commit -m "feat(memory): add the Claude project Memory adapter (scan + write)"
```

---

### Task 6: Resumable local-store migration (v1 -> v2)

**Files:**
- Modify: `packages/memory/src/canonical/claude-project-adapter.ts` (widen one type)
- Create: `packages/memory/src/canonical/migrate.ts`
- Test: `packages/memory/src/canonical/migrate.test.ts`

**Interfaces:**
- Consumes: `readMemoryManifest` from `../store.js`; `readLocalRegistry`, `writeLocalRegistry` from `../project/registry-store.js`; `resolveOrMintProject` from `../project/registry.js`; `readMemoryObject` from `../store.js`; `claudeCanonicalPathOf` from `./claude-project-adapter.js` (widened in Step 1); `readCanonicalMain`, `writeCanonicalMain` from `./store.js` (Task 2); `readProjection`, `writeProjection`, `type ProjectionFile` from `./store.js` (Task 2); `keepBothPath` from `./merge.js` (Task 4); `emptyCanonicalMain`, `type CanonicalMainManifest` from `./domain.js` (Task 1).
- Produces: `class MigrationError extends Error { code: 'migration-invalid' }`, `type MigrationSummary = { migratedDocuments: number; keptBothDuplicates: number; alreadyMigrated: boolean }`, `migrateLocalStore(stackHome: string): Promise<MigrationSummary>`.

- [ ] **Step 1: Widen `claudeCanonicalPathOf`'s parameter type**

In `packages/memory/src/canonical/claude-project-adapter.ts`, change its signature so it also accepts a v1 `ManifestItem` (which has the same `scope`/`kind`/`restoreTarget` shape as `DiscoveredMemoryItem` but no `source`):

```ts
import type { ManifestItem } from '../domain.js';

export const claudeCanonicalPathOf = (
  item: Pick<DiscoveredMemoryItem | ManifestItem, 'scope' | 'kind' | 'restoreTarget'>,
): string | null => {
```

Run `pnpm --filter @stack/memory test -- canonical/claude-project-adapter.test.ts` to confirm this widening is non-breaking (PASS, no assertions changed).

- [ ] **Step 2: Write the failing tests**

Create `packages/memory/src/canonical/migrate.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { memoryManifestSchema, toManifestItem } from '../domain.js';
import { writeMemoryManifest, writeMemoryObject, hashBytes } from '../store.js';
import { readCanonicalMain } from './store.js';
import { migrateLocalStore } from './migrate.js';

let stackHome: string;
beforeEach(async () => {
  stackHome = await mkdtemp(path.join(tmpdir(), 'stak-migrate-'));
});
afterEach(async () => rm(stackHome, { recursive: true, force: true }));

const putObject = async (bytes: Buffer) => {
  const contentHash = hashBytes(bytes);
  await writeMemoryObject({ stackHome, contentHash, bytes });
  return contentHash;
};

describe('migrateLocalStore', () => {
  it('converts a project auto-memory item into canonical notes/, and leaves global items in current.json', async () => {
    const autoHash = await putObject(Buffer.from('hello'));
    const globalHash = await putObject(Buffer.from('global instructions'));
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-20T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/widgets/MEMORY.md',
            project: { kind: 'git', canonical: 'github.com/acme/widgets', host: 'github.com', owner: 'acme', repo: 'widgets' },
            contentHash: autoHash,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'MEMORY.md' },
            capturedAt: '2026-10-20T00:00:00.000Z',
            sensitivity: 'private',
          },
          {
            provider: 'claude',
            kind: 'user-instructions',
            scope: 'global',
            logicalId: 'claude/user-instructions/global/CLAUDE.md',
            contentHash: globalHash,
            restoreTarget: { base: 'claude-home', relativePath: 'CLAUDE.md' },
            capturedAt: '2026-10-20T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });

    const summary = await migrateLocalStore(stackHome);
    expect(summary.alreadyMigrated).toBe(false);
    expect(summary.migratedDocuments).toBe(1);

    const main = await readCanonicalMain(stackHome);
    const doc = main.projects[0]?.documents.find((d) => d.path === 'notes/MEMORY.md');
    expect(doc).toMatchObject({ state: 'present', contentHash: autoHash });

    const current = memoryManifestSchema.parse(
      JSON.parse(await readFile(path.join(stackHome, 'memory', 'manifests', 'current.json'), 'utf8')),
    );
    expect(current.items).toHaveLength(1);
    expect(current.items[0]?.kind).toBe('user-instructions');

    const backupRaw = await readFile(
      path.join(stackHome, 'memory', 'manifests', 'current.v1-premigration.json'),
      'utf8',
    );
    expect(JSON.parse(backupRaw).items).toHaveLength(2);
  });

  it('is idempotent: running twice does not change the result or re-create the backup', async () => {
    const hash = await putObject(Buffer.from('x'));
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-20T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'project-private-instructions',
            scope: 'project',
            logicalId: 'claude/project-private/github.com/acme/widgets/CLAUDE.local.md',
            project: { kind: 'git', canonical: 'github.com/acme/widgets', host: 'github.com', owner: 'acme', repo: 'widgets' },
            contentHash: hash,
            restoreTarget: { base: 'project', relativePath: 'CLAUDE.local.md' },
            capturedAt: '2026-10-20T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });

    const first = await migrateLocalStore(stackHome);
    const backupBefore = await readFile(
      path.join(stackHome, 'memory', 'manifests', 'current.v1-premigration.json'),
      'utf8',
    );
    const second = await migrateLocalStore(stackHome);
    expect(second.alreadyMigrated).toBe(true);
    const backupAfter = await readFile(
      path.join(stackHome, 'memory', 'manifests', 'current.v1-premigration.json'),
      'utf8',
    );
    expect(backupAfter).toBe(backupBefore);
    expect(first.migratedDocuments).toBe(second.migratedDocuments);
  });

  it('seeds the claude projection file so P = C for every migrated document', async () => {
    const hash = await putObject(Buffer.from('seed me'));
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-20T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/widgets/a.md',
            project: { kind: 'git', canonical: 'github.com/acme/widgets', host: 'github.com', owner: 'acme', repo: 'widgets' },
            contentHash: hash,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
            capturedAt: '2026-10-20T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    await migrateLocalStore(stackHome);
    const { readProjection } = await import('./store.js');
    const main = await readCanonicalMain(stackHome);
    const projectId = main.projects[0]!.projectId;
    const projection = await readProjection(stackHome, 'claude');
    expect(projection.projects[projectId]?.['notes/a.md']).toBe(hash);
  });

  it('resumes correctly when interrupted after the backup but before main.json', async () => {
    const hash = await putObject(Buffer.from('resume me'));
    const manifest = {
      schemaVersion: 1 as const,
      provider: 'claude' as const,
      createdAt: '2026-10-20T00:00:00.000Z',
      items: [
        {
          provider: 'claude' as const,
          kind: 'auto-memory' as const,
          scope: 'project' as const,
          logicalId: 'claude/auto-memory/github.com/acme/widgets/a.md',
          project: { kind: 'git' as const, canonical: 'github.com/acme/widgets', host: 'github.com', owner: 'acme', repo: 'widgets' },
          contentHash: hash,
          restoreTarget: { base: 'claude-project-memory' as const, relativePath: 'a.md' },
          capturedAt: '2026-10-20T00:00:00.000Z',
          sensitivity: 'private' as const,
        },
      ],
    };
    await writeMemoryManifest({ stackHome, manifest });
    // Simulate "crashed after backup, before main.json": write the backup file by
    // hand exactly as migrateLocalStore's first step would, then call migrate.
    await writeFile(
      path.join(stackHome, 'memory', 'manifests', 'current.v1-premigration.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx' },
    );
    const summary = await migrateLocalStore(stackHome);
    expect(summary.migratedDocuments).toBe(1);
    const main = await readCanonicalMain(stackHome);
    expect(main.projects).toHaveLength(1);
  });

  it('keeps differing migration duplicates under both paths deterministically — the SAME identity captured twice with different content', async () => {
    // The only SAFE "old duplicate" case: both items carry the SAME git identity
    // (same canonical remote), so they are PROVEN to be the same real project —
    // never guessed from a coincidentally-matching path. A duplicate can arise
    // here because the same project was captured at two different times, under
    // two different (now-irrelevant) vendor keys, before the content stabilized.
    const hashOld = await putObject(Buffer.from('old content'));
    const hashNew = await putObject(Buffer.from('new content'));
    const identity = {
      kind: 'git' as const,
      canonical: 'github.com/acme/widgets',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    };
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-20T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/widgets/a.md#old',
            project: identity,
            contentHash: hashOld,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
            capturedAt: '2026-10-19T00:00:00.000Z',
            sensitivity: 'private',
          },
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/widgets/a.md#new',
            project: identity,
            contentHash: hashNew,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
            capturedAt: '2026-10-21T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    const summary = await migrateLocalStore(stackHome);
    expect(summary.keptBothDuplicates).toBe(1);
    const main = await readCanonicalMain(stackHome);
    expect(main.projects).toHaveLength(1); // one real project, not two
    const paths = main.projects[0]!.documents.map((d) => d.path);
    expect(paths).toContain('notes/a.md'); // latest capturedAt keeps the original path
    expect(paths.some((p) => p.startsWith('notes/a.conflict-'))).toBe(true);
  });

  it('does NOT merge two UNRELATED local (non-Git) projects that happen to share a relative path', async () => {
    // This is the regression this fixture exists to prevent: two different real
    // local projects both having, say, `MEMORY.md` must NEVER be coalesced just
    // because the path matches. Path is never a strong identity signal (same
    // rule as everywhere else in this system) — only a PROVEN shared identity
    // (same git canonical, or the SAME already-resolved Project ID) may coalesce
    // duplicates. Two different `local` vendor keys prove nothing about being
    // the same project, so migration must mint two SEPARATE projects here, with
    // NO keep-both naming and NO cross-project data loss.
    const hashA = await putObject(Buffer.from('project A content'));
    const hashB = await putObject(Buffer.from('project B content'));
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-20T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/local:key-foo/MEMORY.md',
            project: { kind: 'local', vendorKey: 'key-foo' },
            contentHash: hashA,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'MEMORY.md' },
            capturedAt: '2026-10-19T00:00:00.000Z',
            sensitivity: 'private',
          },
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/local:key-bar/MEMORY.md',
            project: { kind: 'local', vendorKey: 'key-bar' },
            contentHash: hashB,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'MEMORY.md' },
            capturedAt: '2026-10-21T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    const summary = await migrateLocalStore(stackHome);
    expect(summary.keptBothDuplicates).toBe(0);
    const main = await readCanonicalMain(stackHome);
    expect(main.projects).toHaveLength(2); // two separate projects, never merged
    for (const project of main.projects) {
      expect(project.documents).toHaveLength(1);
      expect(project.documents[0]!.path).toBe('notes/MEMORY.md'); // each keeps its own, unsuffixed
    }
    const hashes = main.projects.map((p) => (p.documents[0] as { contentHash: string }).contentHash).sort();
    expect(hashes).toEqual([hashA, hashB].sort());
  });

  it('throws migration-invalid for a genuinely broken entry (content missing from the store)', async () => {
    const missingHash = `sha256:${'9'.repeat(64)}`; // never written via putObject
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-20T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'auto-memory',
            scope: 'project',
            logicalId: 'claude/auto-memory/github.com/acme/widgets/broken.md',
            project: { kind: 'git', canonical: 'github.com/acme/widgets', host: 'github.com', owner: 'acme', repo: 'widgets' },
            contentHash: missingHash,
            restoreTarget: { base: 'claude-project-memory', relativePath: 'broken.md' },
            capturedAt: '2026-10-20T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    await expect(migrateLocalStore(stackHome)).rejects.toMatchObject({ code: 'migration-invalid' });
    // Fails BEFORE any mutation: no backup side effect beyond the (harmless,
    // always-written) pre-migration backup file itself, and no canonical main.
    const main = await readCanonicalMain(stackHome);
    expect(main.projects).toEqual([]);
  });

  it('works on a genuinely fresh $STAK_HOME with no manifests directory at all yet', async () => {
    // No writeMemoryManifest call at all — `stackHome` here has never had ANY
    // memory command touch it, so `memory/manifests/` does not exist yet. This
    // is the real first-run path for every brand-new account.
    const summary = await migrateLocalStore(stackHome);
    expect(summary.migratedDocuments).toBe(0);
    expect(summary.alreadyMigrated).toBe(false);
    // Calling it again must still be a safe no-op.
    const second = await migrateLocalStore(stackHome);
    expect(second.alreadyMigrated).toBe(true);
  });

  it('is a true no-op after completion: does not revert global items backed up since, and does not reset the projection', async () => {
    const hash = await putObject(Buffer.from('global instructions v1'));
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-20T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'user-instructions',
            scope: 'global',
            logicalId: 'claude/user-instructions/global/CLAUDE.md',
            contentHash: hash,
            restoreTarget: { base: 'claude-home', relativePath: 'CLAUDE.md' },
            capturedAt: '2026-10-20T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });
    await migrateLocalStore(stackHome); // first run completes migration (no project items here)

    // Simulate a later, independent global backup that updates current.json.
    const newHash = await putObject(Buffer.from('global instructions v2'));
    await writeMemoryManifest({
      stackHome,
      manifest: {
        schemaVersion: 1,
        provider: 'claude',
        createdAt: '2026-10-22T00:00:00.000Z',
        items: [
          {
            provider: 'claude',
            kind: 'user-instructions',
            scope: 'global',
            logicalId: 'claude/user-instructions/global/CLAUDE.md',
            contentHash: newHash,
            restoreTarget: { base: 'claude-home', relativePath: 'CLAUDE.md' },
            capturedAt: '2026-10-22T00:00:00.000Z',
            sensitivity: 'private',
          },
        ],
      },
    });

    await migrateLocalStore(stackHome); // must NOT revert the above

    const current = memoryManifestSchema.parse(
      JSON.parse(await readFile(path.join(stackHome, 'memory', 'manifests', 'current.json'), 'utf8')),
    );
    expect(current.items[0]?.contentHash).toBe(newHash); // not reverted to the old hash
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- canonical/migrate.test.ts`
Expected: FAIL with a module-not-found error for `./migrate.js`

- [ ] **Step 4: Implement `migrate.ts`**

Create `packages/memory/src/canonical/migrate.ts`:

```ts
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { memoryManifestSchema, type ManifestItem } from '../domain.js';
import { memoryStorePaths, readMemoryManifest, readMemoryObject, writeMemoryManifest } from '../store.js';
import { readLocalRegistry, writeLocalRegistry } from '../project/registry-store.js';
import { resolveOrMintProject } from '../project/registry.js';
import { claudeCanonicalPathOf } from './claude-project-adapter.js';
import { keepBothPath } from './merge.js';
import {
  CANONICAL_MAIN_SCHEMA_VERSION,
  type CanonicalDoc,
  type CanonicalMainManifest,
} from './domain.js';
import { readCanonicalMain, writeCanonicalMain, writeProjection } from './store.js';

export class MigrationError extends Error {
  constructor(public readonly code: 'migration-invalid', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

export type MigrationSummary = {
  migratedDocuments: number;
  keptBothDuplicates: number;
  alreadyMigrated: boolean;
};

const premigrationBackupPath = (stackHome: string) =>
  path.join(memoryStorePaths(stackHome).manifests, 'current.v1-premigration.json');

// A dedicated completion marker — NOT just "the backup exists" and NOT just
// "main.json has projects". Both of those are ambiguous: the backup is written
// BEFORE the build step, and an account with zero project memory ever (global
// items only, or genuinely nothing) never populates `main.json` either way, yet
// steps C/D still must run exactly once. Only this marker, written at the very
// end after every step has actually succeeded, can tell "never finished" apart
// from "finished, nothing to migrate" apart from "finished, with real content" —
// and only it is safe to gate re-running steps C/D on without either re-running
// them forever (reverting newer global backups, resetting the projection) or
// skipping a genuine crash-resume.
const migrationCompleteMarkerPath = (stackHome: string) =>
  path.join(memoryStorePaths(stackHome).manifests, '.v1-migration-complete');

const markerExists = async (file: string): Promise<boolean> => {
  try {
    await readFile(file, 'utf8');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

/** Step A: write the pre-migration backup exactly once. A pre-existing backup is
 * read back unchanged (never overwritten), which is what makes later steps safe
 * to resume from after any crash. Schema-validated on read-back so a truncated
 * write (crash mid-write) is caught explicitly rather than surfacing as an
 * opaque `JSON.parse` failure on every future run. Published via `link` (not
 * `rename`), which fails with `EEXIST` instead of silently clobbering an
 * already-published backup — the narrow defense against two processes racing
 * to migrate the same fresh `$STAK_HOME` at once; a losing process simply reads
 * back the winner's backup, same as the ordinary already-exists path. (The
 * remaining lock-free gaps elsewhere in this migration — e.g. two concurrent
 * runs each minting their own Project ID for the same identity — are a known,
 * pre-existing limitation of this feature's lock-free design, not something
 * this task closes; a cross-process store lock is deferred to a later task.) */
const ensureBackup = async (stackHome: string) => {
  const dir = memoryStorePaths(stackHome).manifests;
  const file = premigrationBackupPath(stackHome);
  await mkdir(dir, { recursive: true }); // a genuinely fresh $STAK_HOME has no manifests/ yet
  try {
    const raw = await readFile(file, 'utf8');
    return { manifest: memoryManifestSchema.parse(JSON.parse(raw)), alreadyMigrated: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const current = await readMemoryManifest(stackHome);
  const manifest = current ?? { schemaVersion: 1 as const, provider: 'claude' as const, createdAt: new Date().toISOString(), items: [] };
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await link(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const raw = await readFile(file, 'utf8');
      return { manifest: memoryManifestSchema.parse(JSON.parse(raw)), alreadyMigrated: true };
    }
    throw error;
  }
  await unlink(temp).catch(() => undefined); // drop the now-redundant temp hardlink name
  return { manifest, alreadyMigrated: false };
};

/** Step B: build canonical documents from the backed-up v1 items, resolving/minting
 * Project IDs through the existing registry and persisting any newly minted ones.
 * Grouped by ALREADY-RESOLVED Project ID first, THEN by canonical path — never
 * the reverse. Path alone is never a strong identity signal anywhere else in this
 * system, and it must not become one here: two different local (non-Git)
 * projects can easily share a relative path (every Claude auto-memory project has
 * a `MEMORY.md`), and grouping by path first would silently fold one project's
 * memory into another's as a "duplicate". Grouping by resolved identity first
 * means a duplicate can only ever arise from the SAME proven identity (most
 * commonly: the same Git remote) having been captured more than once with
 * different content — the one case migration can safely and automatically
 * resolve with keep-both naming. A purely local project whose vendor key changed
 * over time (no Git remote ever) is NOT automatically reconciled by migration —
 * it becomes two separate logical projects, which is the safe, conservative
 * outcome; `stak project map` remains available to merge them manually later. */
const buildCanonicalMain = async (
  stackHome: string,
  items: ManifestItem[],
): Promise<{ main: CanonicalMainManifest; keptBothDuplicates: number }> => {
  let registry = await readLocalRegistry(stackHome);
  const byProject = new Map<string, ManifestItem[]>();
  for (const item of items) {
    if (item.scope !== 'project' || !item.project) continue; // global stays in v1
    const canonicalPath = claudeCanonicalPathOf(item);
    if (!canonicalPath) continue;
    const { registry: next, projectId } = resolveOrMintProject(registry, item.project);
    registry = next;
    const group = byProject.get(projectId) ?? [];
    group.push(item);
    byProject.set(projectId, group);
  }
  await writeLocalRegistry(stackHome, registry);

  let keptBothDuplicates = 0;
  const main: CanonicalMainManifest = { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [] };
  for (const [projectId, group] of byProject) {
    const byPath = new Map<string, ManifestItem[]>();
    for (const item of group) {
      const canonicalPath = claudeCanonicalPathOf(item)!;
      const bucket = byPath.get(canonicalPath) ?? [];
      bucket.push(item);
      byPath.set(canonicalPath, bucket);
    }
    const documents: CanonicalDoc[] = [];
    const takenPaths = new Set<string>(byPath.keys());
    for (const [canonicalPath, bucket] of byPath) {
      // Deduplicate identical copies by hash FIRST: several manifest entries can
      // carry the exact same bytes (e.g. carried-forward duplicates from the
      // 2026-10-20-era bugs), and those must collapse into ONE kept-both entry,
      // never one conflict file per duplicate copy. Keep the MOST RECENTLY
      // captured copy per hash (not first-seen) — otherwise which copy's
      // metadata survives depends on manifest array order, the same
      // non-determinism the tie-break below exists to avoid.
      const distinctByHash = new Map<string, ManifestItem>();
      for (const entry of bucket) {
        const prev = distinctByHash.get(entry.contentHash);
        if (!prev || entry.capturedAt > prev.capturedAt) distinctByHash.set(entry.contentHash, entry);
      }
      const distinct = [...distinctByHash.values()];
      if (distinct.length === 1) {
        const winner = distinct[0]!;
        documents.push({
          path: canonicalPath,
          state: 'present',
          contentHash: winner.contentHash,
          importedFrom: 'claude',
          importedAt: winner.capturedAt,
        });
        continue;
      }
      // Deterministic tie-break: `capturedAt` descending, then `contentHash`
      // ascending — two items captured in the SAME backup run share a
      // `capturedAt`, and without a tie-break the "primary" (original-path)
      // winner would depend on manifest array order, which is not deterministic
      // across machines converting the same history.
      const sorted = [...distinct].sort((a, b) =>
        a.capturedAt !== b.capturedAt
          ? a.capturedAt < b.capturedAt ? 1 : -1
          : a.contentHash < b.contentHash ? -1 : 1,
      );
      const [primary, ...rest] = sorted;
      documents.push({
        path: canonicalPath,
        state: 'present',
        contentHash: primary!.contentHash,
        importedFrom: 'claude',
        importedAt: primary!.capturedAt,
      });
      for (const extra of rest) {
        const altPath = keepBothPath(canonicalPath, extra.contentHash, (candidate) => takenPaths.has(candidate));
        takenPaths.add(altPath);
        documents.push({
          path: altPath,
          state: 'present',
          contentHash: extra.contentHash,
          importedFrom: 'claude',
          importedAt: extra.capturedAt,
        });
        keptBothDuplicates += 1;
      }
    }
    main.projects.push({ projectId, documents });
  }
  return { main, keptBothDuplicates };
};

/** Step C: seed the claude projection so every migrated document reads as
 * already synced (P = C), turning later native edits into ordinary edits rather
 * than a wall of first-sighting conflicts. */
const seedClaudeProjection = async (stackHome: string, main: CanonicalMainManifest) => {
  const projects: Record<string, Record<string, string>> = {};
  for (const project of main.projects) {
    const byPath: Record<string, string> = {};
    for (const doc of project.documents)
      if (doc.state === 'present') byPath[doc.path] = doc.contentHash;
    if (Object.keys(byPath).length > 0) projects[project.projectId] = byPath;
  }
  await writeProjection(stackHome, 'claude', { schemaVersion: 1, projects });
};

/** Step D: slim the v1 manifest down to global-only items. */
const slimToGlobal = async (stackHome: string, items: ManifestItem[]) => {
  const globalItems = items.filter((item) => item.scope === 'global');
  await writeMemoryManifest({
    stackHome,
    manifest: { schemaVersion: 1, provider: 'claude', createdAt: new Date().toISOString(), items: globalItems },
  });
};

/**
 * Migrate the local v1 Memory store into the v2 canonical store. Steps A/B are
 * each independently safe to re-run (the backup is write-once; the build is
 * gated on canonical main still being empty), which is what makes a crash
 * BEFORE migration finishes resumable with no separate "resume" algorithm.
 * Steps C/D are different: once migration has genuinely finished, they must
 * NEVER run again — re-seeding the projection would erase progress any later
 * sync made, and re-slimming `current.json` would revert any global backup made
 * since. The completion marker (written only at the very end, after everything
 * else has already succeeded) is what tells "still resuming" apart from "already
 * done, nothing more to do here, ever again".
 */
export const migrateLocalStore = async (stackHome: string): Promise<MigrationSummary> => {
  const markerFile = migrationCompleteMarkerPath(stackHome);
  if (await markerExists(markerFile)) {
    const main = await readCanonicalMain(stackHome);
    return {
      migratedDocuments: main.projects.reduce((n, p) => n + p.documents.length, 0),
      keptBothDuplicates: 0,
      alreadyMigrated: true,
    };
  }

  const { manifest, alreadyMigrated } = await ensureBackup(stackHome);
  for (const item of manifest.items) {
    try {
      await readMemoryObject({ stackHome, contentHash: item.contentHash });
    } catch (error) {
      throw new MigrationError(
        'migration-invalid',
        `Memory migration found a broken entry: content for "${item.logicalId}" is missing from the store.`,
        { cause: error },
      );
    }
  }
  const existingMain = await readCanonicalMain(stackHome);
  const needsBuild = existingMain.projects.length === 0 && manifest.items.some((i: ManifestItem) => i.scope === 'project');
  const { main, keptBothDuplicates } = needsBuild
    ? await buildCanonicalMain(stackHome, manifest.items)
    : { main: existingMain, keptBothDuplicates: 0 };
  if (needsBuild) await writeCanonicalMain(stackHome, main);
  await seedClaudeProjection(stackHome, main);
  await slimToGlobal(stackHome, manifest.items);
  await writeFile(markerFile, new Date().toISOString(), { mode: 0o600 });

  const migratedDocuments = main.projects.reduce((n, p) => n + p.documents.length, 0);
  return { migratedDocuments, keptBothDuplicates, alreadyMigrated };
};
```

Note: `markerExists`/`migrationCompleteMarkerPath` and `premigrationBackupPath`'s directory both live under `memory/manifests/`, which Task 2's exclusion-list work does NOT need to touch — a `.v1-migration-complete` marker and the pre-migration backup are both machine-local artifacts of a ONE-TIME conversion, not portable state, but they are also not referenced by `bundleFromStore`/`restoreBundleToStore` (Task 7) at all, so they simply never travel in a bundle regardless; no new entry in `packages/core/src/state.ts`'s `STATE_EXCLUDE_PATHS` is needed for them specifically (the whole `memory/manifests/` directory is already exercised by existing state-file handling for `current.json`, which legitimately IS portable — these two new files sit alongside it on disk but are simply never read by anything bundle-related).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- canonical/migrate.test.ts`
Expected: PASS

If the "resumes after backup but before main.json" test fails because `needsBuild` cannot tell apart "never built" from "built but empty", inspect whether the fixture's manifest actually contains a project-scope item (it does) — `needsBuild` is keyed off `existingMain.projects.length === 0 AND there exists a project-scope item in the backup`, which is correct for that fixture. If a future fixture legitimately migrates to an empty canonical main (no project-scope items at all), `needsBuild` is already `false` in that case too (the `some(...)` guard), so no rebuild loop occurs — this is intentional, not a bug to fix.

- [ ] **Step 6: Commit**

```bash
git add packages/memory/src/canonical/claude-project-adapter.ts packages/memory/src/canonical/migrate.ts packages/memory/src/canonical/migrate.test.ts
git commit -m "feat(memory): add resumable v1 -> v2 local Memory store migration"
```

---

### Task 7: Bundle v2 and the deterministic old-bundle converter

Factors the "group legacy v1 items by resolved Project ID + canonical path, collapse identical duplicates, keep-both the rest" logic out of `migrate.ts` (Task 6) into a shared pure helper, so the exact same rule drives both local migration and converting a historical Cloud generation — the two places spec section 9 requires it.

**Files:**
- Create: `packages/memory/src/canonical/group-legacy-items.ts`
- Create: `packages/memory/src/canonical/group-legacy-items.test.ts`
- Modify: `packages/memory/src/canonical/migrate.ts` (use the extracted helper)
- Create: `packages/memory/src/canonical/convert-v1.ts`
- Create: `packages/memory/src/canonical/convert-v1.test.ts`
- Modify: `packages/memory/src/remote/bundle-codec.ts`
- Test: `packages/memory/src/remote/bundle-codec.test.ts` (existing file — add v2 cases)

**Interfaces:**
- Produces (`group-legacy-items.ts`): `type GroupedResult = { documents: CanonicalDoc[]; keptBothDuplicates: number }`, `groupLegacyItems(items: Array<ManifestItem & { __projectId: string }>): GroupedResult` — takes items ALREADY tagged with a resolved `projectId` (callers resolve identity their own way, keeping this function itself identity-resolution-free and pure) and groups them per project.
- Produces (`convert-v1.ts`): `convertV1Bundle(bundle: MemoryBackupBundle, options?: { localRegistry?: LocalRegistry }): CanonicalMainManifest` — pure given the same bundle + same `localRegistry` fallback input.
- Produces (`bundle-codec.ts`, additive): `BUNDLE_FORMAT_V2 = 'stack-mem-bundle-v2'`, bundle schema accepts `bundleFormat: BUNDLE_FORMAT | BUNDLE_FORMAT_V2`, optional `canonicalSha256`/`canonicalB64` fields; `bundleFromStore` emits v2 with those fields whenever `canonical/main.json` exists on disk, else v1 unchanged; `restoreBundleToStore` rebuilds `canonical/main.json` when present.

- [ ] **Step 1: Write the failing tests for the shared grouping helper**

Create `packages/memory/src/canonical/group-legacy-items.test.ts`:

```ts
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
    expect(result.documents).toHaveLength(1);
  });

  it('keeps differing duplicates under both deterministic paths, newest keeps the original', () => {
    const result = groupLegacyItems([
      item('prj_x', 'a.md', h(1), '2026-10-19T00:00:00.000Z'),
      item('prj_x', 'a.md', h(2), '2026-10-20T00:00:00.000Z'),
    ]);
    expect(result.keptBothDuplicates).toBe(1);
    const original = result.documents.find((d) => d.path === 'notes/a.md');
    expect(original).toMatchObject({ contentHash: h(2) });
    expect(result.documents.some((d) => d.path.startsWith('notes/a.conflict-'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- canonical/group-legacy-items.test.ts`
Expected: FAIL with a module-not-found error for `./group-legacy-items.js`

- [ ] **Step 3: Implement `group-legacy-items.ts`**

Create `packages/memory/src/canonical/group-legacy-items.ts`:

```ts
import type { ManifestItem } from '../domain.js';
import { keepBothPath } from './merge.js';
import { claudeCanonicalPathOf } from './claude-project-adapter.js';
import { CANONICAL_MAIN_SCHEMA_VERSION, type CanonicalDoc, type CanonicalMainManifest } from './domain.js';

export type GroupedResult = { main: CanonicalMainManifest; keptBothDuplicates: number };

/**
 * Pure grouping of legacy v1 items, each already tagged with its resolved Project
 * ID (`__projectId`), into canonical documents — identical duplicates collapse,
 * differing duplicates keep both under the deterministic keep-both naming from
 * `merge.ts`, with the most recently captured copy keeping the original path.
 * Identity resolution itself is the caller's job (`migrate.ts` mints through the
 * local registry; `convert-v1.ts` reads a snapshot/registry read-only) so this
 * function stays pure and shared between both.
 */
export const groupLegacyItems = (
  items: Array<ManifestItem & { __projectId: string }>,
): GroupedResult => {
  const byProject = new Map<string, Array<ManifestItem & { __projectId: string }>>();
  for (const item of items) {
    const group = byProject.get(item.__projectId) ?? [];
    group.push(item);
    byProject.set(item.__projectId, group);
  }

  let keptBothDuplicates = 0;
  const main: CanonicalMainManifest = { schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION, projects: [] };
  for (const [projectId, group] of [...byProject].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const byPath = new Map<string, Array<ManifestItem & { __projectId: string }>>();
    for (const item of group) {
      const canonicalPath = claudeCanonicalPathOf(item);
      if (!canonicalPath) continue;
      const bucket = byPath.get(canonicalPath) ?? [];
      bucket.push(item);
      byPath.set(canonicalPath, bucket);
    }
    const documents: CanonicalDoc[] = [];
    const takenPaths = new Set<string>(byPath.keys());
    for (const [canonicalPath, bucket] of [...byPath].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const distinctHashes = new Set(bucket.map((entry) => entry.contentHash));
      if (distinctHashes.size === 1) {
        const winner = bucket[0]!;
        documents.push({
          path: canonicalPath,
          state: 'present',
          contentHash: winner.contentHash,
          importedFrom: 'claude',
          importedAt: winner.capturedAt,
        });
        continue;
      }
      const sorted = [...bucket].sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
      const [primary, ...rest] = sorted;
      documents.push({
        path: canonicalPath,
        state: 'present',
        contentHash: primary!.contentHash,
        importedFrom: 'claude',
        importedAt: primary!.capturedAt,
      });
      for (const extra of rest) {
        const altPath = keepBothPath(canonicalPath, extra.contentHash, (candidate) => takenPaths.has(candidate));
        takenPaths.add(altPath);
        documents.push({
          path: altPath,
          state: 'present',
          contentHash: extra.contentHash,
          importedFrom: 'claude',
          importedAt: extra.capturedAt,
        });
        keptBothDuplicates += 1;
      }
    }
    main.projects.push({ projectId, documents });
  }
  return { main, keptBothDuplicates };
};
```

- [ ] **Step 4: Run the grouping tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- canonical/group-legacy-items.test.ts`
Expected: PASS

- [ ] **Step 5: Rewire `migrate.ts`'s `buildCanonicalMain` to call the shared helper**

In `packages/memory/src/canonical/migrate.ts`, replace the body of `buildCanonicalMain` (everything after resolving/minting `registry`) with a call to `groupLegacyItems`:

```ts
import { groupLegacyItems } from './group-legacy-items.js';

const buildCanonicalMain = async (
  stackHome: string,
  items: ManifestItem[],
): Promise<{ main: CanonicalMainManifest; keptBothDuplicates: number }> => {
  let registry = await readLocalRegistry(stackHome);
  const tagged: Array<ManifestItem & { __projectId: string }> = [];
  for (const item of items) {
    if (item.scope !== 'project' || !item.project) continue;
    const { registry: next, projectId } = resolveOrMintProject(registry, item.project);
    registry = next;
    tagged.push({ ...item, __projectId: projectId });
  }
  await writeLocalRegistry(stackHome, registry);
  const { main, keptBothDuplicates } = groupLegacyItems(tagged);
  return { main, keptBothDuplicates };
};
```

Remove the now-unused `keepBothPath` and `claudeCanonicalPathOf` imports from `migrate.ts` if no longer referenced elsewhere in that file (keep `claudeCanonicalPathOf`'s import only if `seedClaudeProjection` or another function in the file still uses it directly — it does not, so remove it; `keepBothPath` is also unused now).

- [ ] **Step 6: Run migration tests to confirm the refactor did not change behavior**

Run: `pnpm --filter @stack/memory test -- canonical/migrate.test.ts`
Expected: PASS (identical results to Task 6)

- [ ] **Step 7: Write the failing tests for `convertV1Bundle`**

Create `packages/memory/src/canonical/convert-v1.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { MemoryManifest } from '../domain.js';
import { emptyRegistry, resolveOrMintProject, toPortableSnapshot } from '../project/registry.js';
import type { MemoryBackupBundle } from '../remote/bundle-codec.js';
import { convertV1Bundle } from './convert-v1.js';

const h = (n: number) => `sha256:${n.toString().padStart(64, '0')}`;

const makeBundle = (
  manifest: MemoryManifest,
  registrySnapshot?: unknown,
): MemoryBackupBundle => ({
  bundleFormat: 'stack-mem-bundle-v1',
  provider: 'claude',
  manifestSha256: h(0),
  manifestB64: Buffer.from(JSON.stringify(manifest)).toString('base64'),
  objects: [],
  ...(registrySnapshot
    ? {
        registrySha256: h(0),
        registryB64: Buffer.from(JSON.stringify(registrySnapshot)).toString('base64'),
      }
    : {}),
});

describe('convertV1Bundle', () => {
  it('is deterministic when the bundle carries its registry snapshot, across two different local registries', () => {
    const identity = { kind: 'git' as const, canonical: 'github.com/acme/widgets', host: 'github.com', owner: 'acme', repo: 'widgets' };
    let registry = emptyRegistry();
    const minted = resolveOrMintProject(registry, identity);
    registry = minted.registry;
    const snapshot = toPortableSnapshot(registry);

    const manifest: MemoryManifest = {
      schemaVersion: 1,
      provider: 'claude',
      createdAt: '2026-10-20T00:00:00.000Z',
      items: [
        {
          provider: 'claude',
          kind: 'auto-memory',
          scope: 'project',
          logicalId: 'claude/auto-memory/github.com/acme/widgets/a.md',
          project: identity,
          contentHash: h(1),
          restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
          capturedAt: '2026-10-20T00:00:00.000Z',
          sensitivity: 'private',
        },
      ],
    };
    const bundle = makeBundle(manifest, snapshot);

    const resultA = convertV1Bundle(bundle);
    // A DIFFERENT local registry (e.g. a different machine's) must not change the
    // result when the bundle carries its own snapshot.
    const differentLocalRegistry = emptyRegistry();
    const resultB = convertV1Bundle(bundle, { localRegistry: differentLocalRegistry });
    expect(resultA).toEqual(resultB);
    expect(resultA.projects[0]?.projectId).toBe(minted.projectId);
    expect(resultA.projects[0]?.documents).toEqual([
      { path: 'notes/a.md', state: 'present', contentHash: h(1), importedFrom: 'claude', importedAt: '2026-10-20T00:00:00.000Z' },
    ]);
  });

  it('falls back to the provided local registry when the bundle has no snapshot', () => {
    const identity = { kind: 'local' as const, vendorKey: 'key-1' };
    let registry = emptyRegistry();
    const minted = resolveOrMintProject(registry, identity);
    registry = minted.registry;

    const manifest: MemoryManifest = {
      schemaVersion: 1,
      provider: 'claude',
      createdAt: '2026-10-20T00:00:00.000Z',
      items: [
        {
          provider: 'claude',
          kind: 'auto-memory',
          scope: 'project',
          logicalId: 'claude/auto-memory/local:key-1/a.md',
          project: identity,
          contentHash: h(1),
          restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
          capturedAt: '2026-10-20T00:00:00.000Z',
          sensitivity: 'private',
        },
      ],
    };
    const bundle = makeBundle(manifest); // no registrySnapshot
    const result = convertV1Bundle(bundle, { localRegistry: registry });
    expect(result.projects[0]?.projectId).toBe(minted.projectId);
  });

  it('skips a project-scope item that resolves to no claim in either source (fail closed, never guesses)', () => {
    const identity = { kind: 'local' as const, vendorKey: 'unregistered-key' };
    const manifest: MemoryManifest = {
      schemaVersion: 1,
      provider: 'claude',
      createdAt: '2026-10-20T00:00:00.000Z',
      items: [
        {
          provider: 'claude',
          kind: 'auto-memory',
          scope: 'project',
          logicalId: 'claude/auto-memory/local:unregistered-key/a.md',
          project: identity,
          contentHash: h(1),
          restoreTarget: { base: 'claude-project-memory', relativePath: 'a.md' },
          capturedAt: '2026-10-20T00:00:00.000Z',
          sensitivity: 'private',
        },
      ],
    };
    const bundle = makeBundle(manifest);
    const result = convertV1Bundle(bundle, { localRegistry: emptyRegistry() });
    expect(result.projects).toEqual([]);
  });
});
```

- [ ] **Step 8: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- canonical/convert-v1.test.ts`
Expected: FAIL with a module-not-found error for `./convert-v1.js`

- [ ] **Step 9: Implement `convert-v1.ts`**

Create `packages/memory/src/canonical/convert-v1.ts`:

```ts
import { memoryManifestSchema, type ManifestItem } from '../domain.js';
import { resolveProjectForIdentity, type LocalRegistry } from '../project/registry.js';
import { emptyRegistry, mergePortableSnapshot, portableRegistrySnapshotSchema } from '../project/registry.js';
import type { MemoryBackupBundle } from '../remote/bundle-codec.js';
import { groupLegacyItems } from './group-legacy-items.js';
import { emptyCanonicalMain, type CanonicalMainManifest } from './domain.js';

/**
 * Deterministically convert a historical v1 bundle into canonical Memory. Pure:
 * depends only on the bundle's own contents, plus `localRegistry` as a fallback
 * ONLY for identities the bundle's own registry snapshot does not cover (a
 * bundle without any snapshot at all, or — in principle — a gap in one). Two
 * machines converting the SAME bundle with the SAME snapshot get the SAME
 * result regardless of their differing local registries; without a snapshot,
 * the result instead depends on whichever `localRegistry` is passed (spec section
 * 9.2's documented limitation for bundles predating the registry snapshot).
 */
export const convertV1Bundle = (
  bundle: MemoryBackupBundle,
  options: { localRegistry?: LocalRegistry } = {},
): CanonicalMainManifest => {
  const manifest = memoryManifestSchema.parse(
    JSON.parse(Buffer.from(bundle.manifestB64, 'base64').toString('utf8')),
  );
  let registry: LocalRegistry = options.localRegistry ?? emptyRegistry();
  if (bundle.registryB64) {
    const snapshot = portableRegistrySnapshotSchema.parse(
      JSON.parse(Buffer.from(bundle.registryB64, 'base64').toString('utf8')),
    );
    registry = mergePortableSnapshot(registry, snapshot).registry;
  }

  const tagged: Array<ManifestItem & { __projectId: string }> = [];
  for (const item of manifest.items) {
    if (item.scope !== 'project' || !item.project) continue;
    const resolution = resolveProjectForIdentity(registry, item.project);
    if (resolution.status !== 'resolved') continue; // fail closed, never guess
    tagged.push({ ...item, __projectId: resolution.projectId });
  }
  if (tagged.length === 0) return emptyCanonicalMain();
  return groupLegacyItems(tagged).main;
};
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- canonical/convert-v1.test.ts`
Expected: PASS

- [ ] **Step 11: Write the failing tests for bundle v2**

Append to `packages/memory/src/remote/bundle-codec.test.ts` (read the existing file first to match its setup helpers):

```ts
import { CANONICAL_MAIN_SCHEMA_VERSION } from '../canonical/domain.js';
import { writeCanonicalMain } from '../canonical/store.js';
import { BUNDLE_FORMAT_V2 } from './bundle-codec.js';

describe('v2 canonical bundling', () => {
  it('emits a v2 bundle with the canonical manifest when one exists', async () => {
    const stackHome = await temp(); // reuse this file's existing temp-dir helper
    await writeMemoryManifest({
      stackHome,
      manifest: { schemaVersion: 1, provider: 'claude', createdAt: '2026-10-22T00:00:00.000Z', items: [] },
    });
    await writeCanonicalMain(stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [{ projectId: 'prj_x', documents: [] }],
    });
    const { bundle } = await bundleFromStore(stackHome);
    expect(bundle.bundleFormat).toBe(BUNDLE_FORMAT_V2);
    expect(bundle.canonicalB64).toBeDefined();
  });

  it('round-trips the canonical manifest through restoreBundleToStore', async () => {
    const source = await temp();
    await writeMemoryManifest({
      stackHome: source,
      manifest: { schemaVersion: 1, provider: 'claude', createdAt: '2026-10-22T00:00:00.000Z', items: [] },
    });
    const canonical = {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION as const,
      projects: [{ projectId: 'prj_x', documents: [] }],
    };
    await writeCanonicalMain(source, canonical);
    const { bytes } = await bundleFromStore(source);

    const target = await temp();
    await restoreBundleToStore({ bytes, stackHome: target });
    const { readCanonicalMain } = await import('../canonical/store.js');
    expect(await readCanonicalMain(target)).toEqual(canonical);
  });

  it('still emits v1 when no canonical manifest exists on disk (back-compat)', async () => {
    const stackHome = await temp();
    await writeMemoryManifest({
      stackHome,
      manifest: { schemaVersion: 1, provider: 'claude', createdAt: '2026-10-22T00:00:00.000Z', items: [] },
    });
    const { bundle } = await bundleFromStore(stackHome);
    expect(bundle.bundleFormat).toBe('stack-mem-bundle-v1');
    expect(bundle.canonicalB64).toBeUndefined();
  });
});
```

- [ ] **Step 12: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- bundle-codec.test.ts`
Expected: FAIL — `BUNDLE_FORMAT_V2` is not exported, `bundle.canonicalB64` is undefined where the test expects it defined

- [ ] **Step 13: Extend `bundle-codec.ts` for v2**

In `packages/memory/src/remote/bundle-codec.ts`:

```ts
import { readFile } from 'node:fs/promises';
// add:
import { canonicalStorePaths, readCanonicalMain, writeCanonicalMain } from '../canonical/store.js';

export const BUNDLE_FORMAT = 'stack-mem-bundle-v1' as const;
export const BUNDLE_FORMAT_V2 = 'stack-mem-bundle-v2' as const;

const bundleSchema = z.object({
  bundleFormat: z.union([z.literal(BUNDLE_FORMAT), z.literal(BUNDLE_FORMAT_V2)]),
  provider: z.literal('claude'),
  manifestSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  manifestB64: z.string(),
  objects: z.array(bundleObjectSchema),
  registrySha256: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  registryB64: z.string().optional(),
  // v2 only: the canonical Project Memory manifest, byte-exact.
  canonicalSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  canonicalB64: z.string().optional(),
});
```

Update `serialize` to include the canonical fields (only when both are present, mirroring the registry pair):

```ts
const serialize = (bundle: MemoryBackupBundle): Buffer => {
  const canonical = {
    bundleFormat: bundle.bundleFormat,
    provider: bundle.provider,
    manifestSha256: bundle.manifestSha256,
    manifestB64: bundle.manifestB64,
    objects: [...bundle.objects]
      .sort((a, b) => (a.contentHash < b.contentHash ? -1 : 1))
      .map((object) => ({ contentHash: object.contentHash, bytesB64: object.bytesB64 })),
    ...(bundle.registrySha256 && bundle.registryB64
      ? { registrySha256: bundle.registrySha256, registryB64: bundle.registryB64 }
      : {}),
    ...(bundle.canonicalSha256 && bundle.canonicalB64
      ? { canonicalSha256: bundle.canonicalSha256, canonicalB64: bundle.canonicalB64 }
      : {}),
  };
  return Buffer.from(JSON.stringify(canonical), 'utf8');
};
```

Update `bundleFromStore` to read `canonical/main.json` directly (not through `readCanonicalMain`'s empty-default fallback, so a never-migrated store still produces a byte-identical v1 bundle) and switch `bundleFormat`:

```ts
export const bundleFromStore = async (
  stackHome: string,
): Promise<{ bundle: MemoryBackupBundle; bytes: Buffer }> => {
  const manifest = await readMemoryManifest(stackHome);
  if (!manifest) throw new BundleError('no-backup', 'No Memory backup exists to bundle.');
  const manifestBytes = await readFile(memoryStorePaths(stackHome).currentManifest);
  const objects = [];
  for (const contentHash of referencedHashes(manifest)) {
    const bytes = await readMemoryObject({ stackHome, contentHash });
    objects.push({ contentHash, bytesB64: Buffer.from(bytes).toString('base64') });
  }
  const registryBytes = await readFile(memoryStorePaths(stackHome).projectRegistrySnapshot).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  const canonicalBytes = await readFile(canonicalStorePaths(stackHome).main).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  const bundle: MemoryBackupBundle = {
    bundleFormat: canonicalBytes ? BUNDLE_FORMAT_V2 : BUNDLE_FORMAT,
    provider: 'claude',
    manifestSha256: hashBytes(manifestBytes),
    manifestB64: manifestBytes.toString('base64'),
    objects,
    ...(registryBytes
      ? { registrySha256: hashBytes(registryBytes), registryB64: registryBytes.toString('base64') }
      : {}),
    ...(canonicalBytes
      ? { canonicalSha256: hashBytes(canonicalBytes), canonicalB64: canonicalBytes.toString('base64') }
      : {}),
  };
  return { bundle, bytes: serialize(bundle) };
};
```

Update `restoreBundleToStore` to also rebuild `canonical/main.json` when present:

```ts
  if (bundle.canonicalB64 && bundle.canonicalSha256) {
    const canonicalBytes = Buffer.from(bundle.canonicalB64, 'base64');
    if (hashBytes(canonicalBytes) !== bundle.canonicalSha256)
      throw new BundleError('manifest-hash-mismatch', 'The bundled canonical Memory manifest does not match its hash.');
    await atomicWriteFile(canonicalStorePaths(options.stackHome).main, canonicalBytes);
  }
```

Add this block right after the existing registry-rebuild block in `restoreBundleToStore`, before the final `return`.

- [ ] **Step 14: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- bundle-codec.test.ts canonical/`
Expected: PASS

- [ ] **Step 15: Commit**

```bash
git add packages/memory/src/canonical/group-legacy-items.ts packages/memory/src/canonical/group-legacy-items.test.ts packages/memory/src/canonical/migrate.ts packages/memory/src/canonical/convert-v1.ts packages/memory/src/canonical/convert-v1.test.ts packages/memory/src/remote/bundle-codec.ts packages/memory/src/remote/bundle-codec.test.ts
git commit -m "feat(memory): add stack-mem-bundle-v2 and the deterministic old-bundle converter"
```

---

### Task 8: Server version gate and v2 project counts

**Files:**
- Modify: `packages/memory/src/remote/backend.ts`
- Test: `packages/memory/src/remote/backend.test.ts` (existing file — add cases)
- Modify: `packages/memory/src/remote/project-counts.ts`
- Test: `packages/memory/src/remote/project-counts.test.ts` (existing file — add v2 cases)

**Interfaces:**
- Consumes: `BUNDLE_FORMAT`, `BUNDLE_FORMAT_V2` from `./bundle-codec.js` (Task 7).
- Produces: a new `RemoteMemoryError` code `'incompatible-format'`; `standardProjectCountsFromBundle` additionally reads `bundle.canonicalB64` when present.

- [ ] **Step 1: Write the failing test for the version gate**

Read `packages/memory/src/remote/backend.test.ts` first to match its existing `InMemoryRemoteMemoryBackend`-construction helper, then add:

```ts
import { BUNDLE_FORMAT, BUNDLE_FORMAT_V2 } from './bundle-codec.js';
import { RemoteMemoryError } from './backend.js';

describe('version gate', () => {
  it('rejects a v1 generation once the latest committed generation is v2', async () => {
    const backend = /* construct the same way this file's other tests do */ makeBackend();
    await backend.createGeneration({
      backupId: 'b1',
      expectedParent: null,
      privacyMode: 'standard',
      payload: Buffer.from('v2-payload'),
      bundleFormatVersion: BUNDLE_FORMAT_V2,
    });
    await expect(
      backend.createGeneration({
        backupId: 'b2',
        expectedParent: 0,
        privacyMode: 'standard',
        payload: Buffer.from('v1-payload'),
        bundleFormatVersion: BUNDLE_FORMAT,
      }),
    ).rejects.toMatchObject({ code: 'incompatible-format' });
  });

  it('still allows v1 after v1 (no account has upgraded yet)', async () => {
    const backend = makeBackend();
    await backend.createGeneration({
      backupId: 'b1',
      expectedParent: null,
      privacyMode: 'standard',
      payload: Buffer.from('v1-payload-1'),
      bundleFormatVersion: BUNDLE_FORMAT,
    });
    await expect(
      backend.createGeneration({
        backupId: 'b2',
        expectedParent: 0,
        privacyMode: 'standard',
        payload: Buffer.from('v1-payload-2'),
        bundleFormatVersion: BUNDLE_FORMAT,
      }),
    ).resolves.toBeDefined();
  });

  it('allows v2 after v2', async () => {
    const backend = makeBackend();
    await backend.createGeneration({
      backupId: 'b1',
      expectedParent: null,
      privacyMode: 'standard',
      payload: Buffer.from('v2-payload-1'),
      bundleFormatVersion: BUNDLE_FORMAT_V2,
    });
    await expect(
      backend.createGeneration({
        backupId: 'b2',
        expectedParent: 0,
        privacyMode: 'standard',
        payload: Buffer.from('v2-payload-2'),
        bundleFormatVersion: BUNDLE_FORMAT_V2,
      }),
    ).resolves.toBeDefined();
  });
});
```

Replace `makeBackend()` with however this test file already constructs an `InMemoryRemoteMemoryBackend` for one user (match the existing pattern exactly — do not invent a new construction helper).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- remote/backend.test.ts`
Expected: FAIL — the v1-after-v2 case resolves instead of rejecting with `incompatible-format`

- [ ] **Step 3: Implement the version gate**

In `packages/memory/src/remote/backend.ts`:

```ts
export class RemoteMemoryError extends Error {
  constructor(
    public readonly code:
      | 'conflict'
      | 'not-found'
      | 'too-large'
      | 'integrity'
      | 'not-protected'
      | 'mmk-required'
      | 'session-consumed'
      | 'session-expired'
      | 'no-envelope'
      | 'incompatible-format',
    message: string,
  ) {
    super(message);
    this.name = 'RemoteMemoryError';
  }
}
```

Add the check in `createGeneration`, right after the `expectedParent` conflict check and before the backup-id-exists check:

```ts
    if (input.expectedParent !== currentParent)
      throw new RemoteMemoryError(/* unchanged */);
    if (
      latest &&
      latest.bundleFormatVersion !== input.bundleFormatVersion &&
      latest.bundleFormatVersion === 'stack-mem-bundle-v2' &&
      input.bundleFormatVersion === 'stack-mem-bundle-v1'
    )
      throw new RemoteMemoryError(
        'incompatible-format',
        'This account’s Memory was upgraded by a newer STAK CLI. Update with `npm i -g @memstk/cli@beta`.',
      );
```

Note: this compares the literal string values rather than importing `BUNDLE_FORMAT`/`BUNDLE_FORMAT_V2` from `./bundle-codec.js`, because `bundle-codec.ts` already imports from `../canonical/store.js` (Task 7) and `backend.ts` must not gain a reverse dependency on the bundle codec — it only needs the two literal strings, which are part of the stable wire contract either way. If `bundle-codec.ts` does not depend on `backend.ts` (confirm this with `pnpm --filter @stack/memory exec madge --circular src` or a quick grep for `from '../remote/backend'` in `bundle-codec.ts` — there should be none), importing the constants instead of hardcoding the literals is preferable; use `import { BUNDLE_FORMAT, BUNDLE_FORMAT_V2 } from './bundle-codec.js';` and compare against those constants if the grep confirms no cycle.

Add a doc comment above `RemoteMemoryBackend` noting the policy applies to every implementation of the interface, not just the in-memory one:

```ts
/**
 * ...(existing doc)...
 * Phase: STAK-native Project Memory. `createGeneration` must reject a
 * `stack-mem-bundle-v1` payload once this account's latest committed generation
 * is `stack-mem-bundle-v2` (RemoteMemoryError 'incompatible-format') — every
 * implementation of this interface (in-memory, and any future production
 * backend) must enforce this, not just the one below.
 */
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- remote/backend.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for v2 project counts**

Read `packages/memory/src/remote/project-counts.test.ts` first to match its fixture style, then add:

```ts
import { writeCanonicalMain } from '../canonical/store.js';
import { CANONICAL_MAIN_SCHEMA_VERSION } from '../canonical/domain.js';
import { bundleFromStore } from './bundle-codec.js';
// ... plus this file's existing helpers for writing a v1 manifest/objects to a temp stackHome

it('counts present documents per project from a v2 bundle, ignoring tombstones', async () => {
  const stackHome = await temp(); // this file's existing temp-dir helper
  await writeMemoryManifest({
    stackHome,
    manifest: { schemaVersion: 1, provider: 'claude', createdAt: '2026-10-22T00:00:00.000Z', items: [] },
  });
  await writeCanonicalMain(stackHome, {
    schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
    projects: [
      {
        projectId: 'prj_a',
        documents: [
          { path: 'notes/a.md', state: 'present', contentHash: `sha256:${'1'.repeat(64)}`, importedFrom: 'claude', importedAt: '2026-10-22T00:00:00.000Z' },
          { path: 'notes/b.md', state: 'deleted', lastContentHash: `sha256:${'2'.repeat(64)}`, deletedAt: '2026-10-22T00:00:00.000Z' },
        ],
      },
    ],
  });
  const { bytes } = await bundleFromStore(stackHome);
  expect(standardProjectCountsFromBundle(bytes)).toEqual([{ projectId: 'prj_a', fileCount: 1 }]);
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- remote/project-counts.test.ts`
Expected: FAIL — v2 bundle currently returns `null` (no `registryB64`) instead of the canonical-derived counts

- [ ] **Step 7: Implement v2 counting**

In `packages/memory/src/remote/project-counts.ts`, add a v2 branch checked before the existing v1 logic:

```ts
import { canonicalMainManifestSchema } from '../canonical/domain.js';

export const standardProjectCountsFromBundle = (
  bytes: Uint8Array,
): ProjectFileCount[] | null => {
  try {
    const bundle = parseBundle(bytes);
    if (bundle.canonicalB64) {
      const main = canonicalMainManifestSchema.parse(
        JSON.parse(Buffer.from(bundle.canonicalB64, 'base64').toString('utf8')),
      );
      return main.projects
        .map((project) => ({
          projectId: project.projectId,
          fileCount: project.documents.filter((doc) => doc.state === 'present').length,
        }))
        .filter((entry) => entry.fileCount > 0)
        .sort((a, b) => (a.projectId < b.projectId ? -1 : 1));
    }
    // v1 fallback (unchanged below).
    if (!bundle.registryB64) return null;
    /* ...rest of the existing function body, unchanged... */
  } catch {
    return null;
  }
};
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- remote/project-counts.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/memory/src/remote/backend.ts packages/memory/src/remote/backend.test.ts packages/memory/src/remote/project-counts.ts packages/memory/src/remote/project-counts.test.ts
git commit -m "feat(memory): reject v1-after-v2 pushes and read v2 project counts"
```

---

### Task 9: Push algorithm (fast-forward / merge / retry)

`push.ts` is pure orchestration: it takes small injected functions for every I/O operation (read/write local state, fetch a remote generation's canonical content, publish a new generation) so the fast-forward/merge/retry/crash-repair logic (spec section 8.2 and Appendix A.4) is unit-testable with fakes, with no real network or crypto. Task 11 wires the real implementations of those injected functions.

**Files:**
- Create: `packages/memory/src/canonical/push.ts`
- Test: `packages/memory/src/canonical/push.test.ts`

**Interfaces:**
- Consumes: `CanonicalMainManifest`, `canonicalDigest` from `./domain.js` (Task 1); `mergeCanonical`, `type MergeConflict`, `mergeConflictSchema` from `./merge.js` (Task 4); `readCanonicalMain`, `writeCanonicalBase`, `readCanonicalBase`, `writePendingMerge`, `clearPendingMerge` from `./store.js` (Task 2).
- Produces:
  - `type RemoteCanonical = { generation: number; main: CanonicalMainManifest }`
  - `type PublishConflictError = { code: 'conflict' }` (the shape `publish` rejects with — matches `RemoteMemoryError`'s `code: 'conflict'`, checked with `instanceof`-free duck typing so this module never imports `RemoteMemoryError` directly)
  - `type PushDeps = { getLocalMain(): Promise<CanonicalMainManifest>; getBase(): Promise<{ generation: number; main: CanonicalMainManifest } | null>; setBase(base: { generation: number; main: CanonicalMainManifest }): Promise<void>; fetchRemote(): Promise<RemoteCanonical | null>; publish(main: CanonicalMainManifest, expectedParent: number | null): Promise<{ generation: number }>; savePendingMerge(pending: { basedOnGeneration: number; merged: CanonicalMainManifest; conflicts: MergeConflict[] }): Promise<void>; clearPendingMerge(): Promise<void>; maxAttempts?: number; }` — this module is PUSH-only; `stak pull` (Task 13) never calls it, since pull's "merge locally, upload nothing" semantics (spec section 8.4) are genuinely different from push's "always resolves by either publishing or stopping on conflict" and get their own small function in Task 13 instead of a flag bent onto this one.
  - `type PushOutcome = | { status: 'up-to-date'; generation: number } | { status: 'pushed'; generation: number; main: CanonicalMainManifest } | { status: 'conflict'; conflicts: MergeConflict[] } | { status: 'retry-exhausted' }`
  - `class PushError extends Error { code: 'retry-exhausted' }`
  - `pushCanonicalMemory(deps: PushDeps): Promise<PushOutcome>`

- [ ] **Step 1: Write the failing tests**

Create `packages/memory/src/canonical/push.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- canonical/push.test.ts`
Expected: FAIL with a module-not-found error for `./push.js`

- [ ] **Step 3: Implement `push.ts`**

Create `packages/memory/src/canonical/push.ts`:

```ts
import { canonicalDigest, emptyCanonicalMain, type CanonicalMainManifest } from './domain.js';
import { mergeCanonical, type MergeConflict } from './merge.js';

export type RemoteCanonical = { generation: number; main: CanonicalMainManifest };

export type PushDeps = {
  getLocalMain(): Promise<CanonicalMainManifest>;
  getBase(): Promise<{ generation: number; main: CanonicalMainManifest } | null>;
  setBase(base: { generation: number; main: CanonicalMainManifest }): Promise<void>;
  fetchRemote(): Promise<RemoteCanonical | null>;
  publish(main: CanonicalMainManifest, expectedParent: number | null): Promise<{ generation: number }>;
  savePendingMerge(pending: {
    basedOnGeneration: number;
    merged: CanonicalMainManifest;
    conflicts: MergeConflict[];
  }): Promise<void>;
  clearPendingMerge(): Promise<void>;
  maxAttempts?: number;
};

export type PushOutcome =
  | { status: 'up-to-date'; generation: number }
  | { status: 'pushed'; generation: number; main: CanonicalMainManifest }
  | { status: 'conflict'; conflicts: MergeConflict[] }
  | { status: 'retry-exhausted' };

const isConflictError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'conflict';

/**
 * Push canonical Memory: fast-forward when nothing else changed Cloud since this
 * machine's base, three-way merge when it did, and an all-or-nothing stop on any
 * real conflict. See spec section 8.2 and Appendix A.4. One check runs before
 * anything else: if Cloud's current latest is already semantically identical to
 * local, repair the base and stop — this is what makes a crash between a
 * successful `publish` and the local `setBase` self-heal on the next push, instead
 * of creating a duplicate generation.
 */
export const pushCanonicalMemory = async (deps: PushDeps): Promise<PushOutcome> => {
  const maxAttempts = deps.maxAttempts ?? 3;
  const local = await deps.getLocalMain();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remote = await deps.fetchRemote();
    const base = await deps.getBase();

    if (remote && canonicalDigest(remote.main) === canonicalDigest(local)) {
      await deps.setBase({ generation: remote.generation, main: local });
      return { status: 'up-to-date', generation: remote.generation };
    }

    const isFastForward =
      (base === null && remote === null) ||
      (base !== null && remote !== null && base.generation === remote.generation);

    if (isFastForward) {
      const expectedParent = remote?.generation ?? null;
      try {
        const result = await deps.publish(local, expectedParent);
        await deps.setBase({ generation: result.generation, main: local });
        return { status: 'pushed', generation: result.generation, main: local };
      } catch (error) {
        if (!isConflictError(error) || attempt === maxAttempts) break;
        continue; // Cloud moved again mid-push; retry against the new latest.
      }
    }

    // Merge path: something else changed Cloud since this machine's base.
    const baseMain = base?.main ?? emptyCanonicalMain();
    const remoteGeneration = remote!.generation; // non-null: isFastForward handles the null/null case
    const { merged, conflicts } = mergeCanonical(baseMain, local, remote!.main);
    if (conflicts.length > 0) {
      await deps.savePendingMerge({ basedOnGeneration: remoteGeneration, merged, conflicts });
      return { status: 'conflict', conflicts };
    }
    try {
      const result = await deps.publish(merged, remoteGeneration);
      await deps.setBase({ generation: result.generation, main: merged });
      await deps.clearPendingMerge();
      return { status: 'pushed', generation: result.generation, main: merged };
    } catch (error) {
      if (!isConflictError(error) || attempt === maxAttempts) break;
      continue;
    }
  }
  return { status: 'retry-exhausted' };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- canonical/push.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/canonical/push.ts packages/memory/src/canonical/push.test.ts
git commit -m "feat(memory): add the canonical Memory push algorithm (fast-forward/merge/retry)"
```

---

### Task 9A: Pull algorithm (merge, never publish)

Pull's semantics genuinely differ from push's (spec section 8.4: "no unpushed local changes: get the latest version... unpushed local changes: merge the same way as push, but upload nothing"), so this is its own small state machine rather than a flag bent onto `push.ts`. A successful merge-pull DOES advance the local base to the Cloud generation it merged against (even though nothing was uploaded) — this is what lets the very next `stak push` fast-forward the merged result as a plain new generation instead of re-merging.

**Files:**
- Create: `packages/memory/src/canonical/pull.ts`
- Test: `packages/memory/src/canonical/pull.test.ts`

**Interfaces:**
- Consumes: `canonicalDigest`, `emptyCanonicalMain`, `type CanonicalMainManifest` from `./domain.js` (Task 1); `mergeCanonical`, `type MergeConflict` from `./merge.js` (Task 4); `type RemoteCanonical` from `./push.js` (Task 9).
- Produces: `type PullDeps = { getLocalMain(): Promise<CanonicalMainManifest>; getBase(): Promise<{ generation: number; main: CanonicalMainManifest } | null>; setLocalMain(main: CanonicalMainManifest): Promise<void>; setBase(base: { generation: number; main: CanonicalMainManifest }): Promise<void>; fetchRemote(): Promise<RemoteCanonical | null>; savePendingMerge(pending: { basedOnGeneration: number; merged: CanonicalMainManifest; conflicts: MergeConflict[] }): Promise<void>; clearPendingMerge(): Promise<void>; }`, `type PullOutcome = | { status: 'up-to-date'; generation: number | null } | { status: 'merged-local'; main: CanonicalMainManifest } | { status: 'conflict'; conflicts: MergeConflict[] }`, `pullCanonicalMemory(deps: PullDeps): Promise<PullOutcome>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/memory/src/canonical/pull.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- canonical/pull.test.ts`
Expected: FAIL with a module-not-found error for `./pull.js`

- [ ] **Step 3: Implement `pull.ts`**

Create `packages/memory/src/canonical/pull.ts`:

```ts
import { canonicalDigest, emptyCanonicalMain, type CanonicalMainManifest } from './domain.js';
import { mergeCanonical, type MergeConflict } from './merge.js';
import type { RemoteCanonical } from './push.js';

export type PullDeps = {
  getLocalMain(): Promise<CanonicalMainManifest>;
  getBase(): Promise<{ generation: number; main: CanonicalMainManifest } | null>;
  setLocalMain(main: CanonicalMainManifest): Promise<void>;
  setBase(base: { generation: number; main: CanonicalMainManifest }): Promise<void>;
  fetchRemote(): Promise<RemoteCanonical | null>;
  savePendingMerge(pending: {
    basedOnGeneration: number;
    merged: CanonicalMainManifest;
    conflicts: MergeConflict[];
  }): Promise<void>;
  clearPendingMerge(): Promise<void>;
};

export type PullOutcome =
  | { status: 'up-to-date'; generation: number | null }
  | { status: 'merged-local'; main: CanonicalMainManifest }
  | { status: 'conflict'; conflicts: MergeConflict[] };

/**
 * Pull canonical Memory: merge in whatever Cloud has, but NEVER create a Cloud
 * generation. On a clean merge, both local main and the local base advance (to
 * the generation just merged against) so the next `stak push` can fast-forward
 * the merge result up as an ordinary new generation. See spec section 8.4.
 */
export const pullCanonicalMemory = async (deps: PullDeps): Promise<PullOutcome> => {
  const remote = await deps.fetchRemote();
  if (!remote) return { status: 'up-to-date', generation: null };

  const local = await deps.getLocalMain();
  if (canonicalDigest(remote.main) === canonicalDigest(local))
    return { status: 'up-to-date', generation: remote.generation };

  const base = await deps.getBase();
  if (base !== null && base.generation === remote.generation)
    // Cloud has not moved since our base; any difference from remote is purely
    // local, unpushed work — nothing new to pull.
    return { status: 'up-to-date', generation: remote.generation };

  const baseMain = base?.main ?? emptyCanonicalMain();
  const { merged, conflicts } = mergeCanonical(baseMain, local, remote.main);
  if (conflicts.length > 0) {
    await deps.savePendingMerge({ basedOnGeneration: remote.generation, merged, conflicts });
    return { status: 'conflict', conflicts };
  }
  await deps.setLocalMain(merged);
  await deps.setBase({ generation: remote.generation, main: merged });
  await deps.clearPendingMerge();
  return { status: 'merged-local', main: merged };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- canonical/pull.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/canonical/pull.ts packages/memory/src/canonical/pull.test.ts
git commit -m "feat(memory): add the canonical Memory pull algorithm (merge, never publish)"
```

---

### Task 10: Project-sync orchestration (plan, import-apply, materialize-apply)

Ties `sync.ts`'s pure N/P/C plan to real I/O: the Claude adapter's `scan`/`write`, the canonical store, and the content-addressed object store. Implements the mass-delete guard (spec section 6) by stripping a missing native root's previously-known paths from the projection BEFORE planning — which `planSync` (Task 3) already turns into a `materialize-write` ("regenerate it") rather than an `import-delete` ("you deleted it"), with no change needed to `sync.ts` itself.

**Files:**
- Modify: `packages/memory/src/canonical/claude-project-adapter.ts` (add `nativeRootsExist`)
- Create: `packages/memory/src/canonical/project-sync.ts`
- Test: `packages/memory/src/canonical/project-sync.test.ts`

**Interfaces:**
- Consumes: `planSync`, `type NativeEntry`, `type SyncAction` from `./sync.js` (Task 3); `namespaceOf` from `./paths.js` (Task 1); `readCanonicalMain`, `writeCanonicalMain`, `readProjection`, `writeProjection` from `./store.js` (Task 2); `projectMemoryOf`, `type CanonicalDoc`, `type CanonicalMainManifest` from `./domain.js` (Task 1); `scanClaudeProject`, `writeClaudeProject`, `type BoundProject`, `type ScanResult`, `type MaterializeOp` from `./claude-project-adapter.js` (Task 5); `writeMemoryObject`, `readMemoryObject` from `../store.js`.
- Produces:
  - `type ProjectSyncPlan = { actions: SyncAction[]; sourceConflicts: { canonicalPath: string }[]; guardedPaths: string[] }`
  - `planProjectSync(project: BoundProject, stackHome: string, scanOptions: ScanOptionsForAdapter): Promise<ProjectSyncPlan>`
  - `applyImportActions(project: BoundProject, stackHome: string, scanResult: ScanResult, actions: SyncAction[]): Promise<{ imported: string[] }>`
  - `applyMaterializeActions(project: BoundProject, stackHome: string, actions: SyncAction[], claudeHome?: string): Promise<{ written: string[]; deleted: string[] }>`

`ScanOptionsForAdapter` is exactly `scanClaudeProject`'s second parameter type (re-exported, not redefined) — `planProjectSync` is Claude-specific for V0 (spec scope lock: no Cursor/Codex), so it calls `scanClaudeProject` directly rather than through a generic adapter registry.

- [ ] **Step 1: Add `nativeRootsExist` to the Claude adapter**

In `packages/memory/src/canonical/claude-project-adapter.ts`, add:

```ts
import { stat } from 'node:fs/promises';

export type NativeRoots = { projectDirExists: boolean; notesRootExists: boolean };

const isDir = async (candidate: string): Promise<boolean> => {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
};

/** Whether this project's native roots exist on THIS machine — the mass-delete
 * guard's existence check (spec section 6): a missing root means "not
 * materialized here", never "everything in it was deleted". */
export const nativeRootsExist = async (
  project: BoundProject,
  claudeHome: string = path.join(os.homedir(), '.claude'),
): Promise<NativeRoots> => ({
  projectDirExists: await isDir(project.dir),
  notesRootExists: await isDir(
    path.join(claudeHome, 'projects', encodeClaudeProjectKey(path.resolve(project.dir)), 'memory'),
  ),
});
```

- [ ] **Step 2: Write the failing tests**

Create `packages/memory/src/canonical/project-sync.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashBytes, readMemoryObject, writeMemoryObject } from '../store.js';
import { CANONICAL_MAIN_SCHEMA_VERSION, type CanonicalDoc } from './domain.js';
import { writeCanonicalMain, readCanonicalMain, writeProjection, readProjection } from './store.js';
import { applyImportActions, applyMaterializeActions, planProjectSync } from './project-sync.js';

const write = async (file: string, body: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
};

let root: string;
let stackHome: string;
let claudeHome: string;
let projectDir: string;
const project = { projectId: 'prj_x', dir: '' };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'stak-project-sync-'));
  stackHome = path.join(root, 'stack-home');
  claudeHome = path.join(root, '.claude');
  projectDir = path.join(root, 'proj');
  await mkdir(projectDir, { recursive: true });
  project.dir = projectDir;
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe('planProjectSync', () => {
  it('reports no actions when the project directory does not exist on this machine', async () => {
    const plan = await planProjectSync(
      { projectId: 'prj_x', dir: path.join(root, 'missing') },
      stackHome,
      { claudeHome, projects: [{ dir: path.join(root, 'missing') }], resolveProjectId: () => 'prj_x' },
    );
    expect(plan.actions).toEqual([]);
  });

  it('plans a native edit as import-edit', async () => {
    await write(path.join(projectDir, 'CLAUDE.local.md'), 'private v1');
    const plan = await planProjectSync(project, stackHome, {
      claudeHome,
      projects: [{ dir: projectDir }],
      resolveProjectId: () => 'prj_x',
    });
    expect(plan.actions).toEqual([
      { kind: 'import-edit', path: 'instructions/private.md', contentHash: hashBytes(Buffer.from('private v1')) },
    ]);
  });

  it('mass-delete guard: a missing notes root plans a materialize-write (regenerate), never an import-delete', async () => {
    const bytes = Buffer.from('MEMORY content');
    const contentHash = hashBytes(bytes);
    await writeMemoryObject({ stackHome, contentHash, bytes });
    await writeCanonicalMain(stackHome, {
      schemaVersion: CANONICAL_MAIN_SCHEMA_VERSION,
      projects: [{ projectId: 'prj_x', documents: [{ path: 'notes/MEMORY.md', state: 'present', contentHash, importedFrom: 'claude', importedAt: '2026-10-22T00:00:00.000Z' }] }],
    });
    await writeProjection(stackHome, 'claude', { schemaVersion: 1, projects: { prj_x: { 'notes/MEMORY.md': contentHash } } });
    // Note: claudeHome/projects/<key>/memory is never created, so the notes root is missing.

    const plan = await planProjectSync(project, stackHome, {
      claudeHome,
      projects: [{ dir: projectDir }],
      resolveProjectId: () => 'prj_x',
    });
    expect(plan.guardedPaths).toEqual(['notes/MEMORY.md']);
    expect(plan.actions).toContainEqual({ kind: 'materialize-write', path: 'notes/MEMORY.md', contentHash });
    expect(plan.actions.some((a) => a.kind === 'import-delete')).toBe(false);
  });
});

describe('applyImportActions and applyMaterializeActions', () => {
  it('imports a native edit into canonical, then materializes a canonical-only change back out', async () => {
    await write(path.join(projectDir, 'CLAUDE.local.md'), 'private v1');
    let plan = await planProjectSync(project, stackHome, {
      claudeHome,
      projects: [{ dir: projectDir }],
      resolveProjectId: () => 'prj_x',
    });
    const { scanClaudeProject } = await import('./claude-project-adapter.js');
    const scanResult = await scanClaudeProject(project, {
      claudeHome,
      projects: [{ dir: projectDir }],
      resolveProjectId: () => 'prj_x',
    });
    await applyImportActions(project, stackHome, scanResult, plan.actions);

    const main = await readCanonicalMain(stackHome);
    expect(main.projects[0]?.documents[0]).toMatchObject({ path: 'instructions/private.md', state: 'present' });
    const projection = await readProjection(stackHome, 'claude');
    expect(projection.projects['prj_x']?.['instructions/private.md']).toBeDefined();

    // Now simulate a canonical-only change (as if it arrived from another machine).
    const mainAfterRemote = await readCanonicalMain(stackHome);
    const newHash = hashBytes(Buffer.from('private v2'));
    await writeMemoryObject({ stackHome, contentHash: newHash, bytes: Buffer.from('private v2') });
    await writeCanonicalMain(stackHome, {
      ...mainAfterRemote,
      projects: mainAfterRemote.projects.map((p) => ({
        ...p,
        documents: p.documents.map((d) => (d.path === 'instructions/private.md' ? { ...d, state: 'present' as const, contentHash: newHash, importedAt: '2026-10-22T00:00:00.000Z' } : d)),
      })),
    });
    plan = await planProjectSync(project, stackHome, {
      claudeHome,
      projects: [{ dir: projectDir }],
      resolveProjectId: () => 'prj_x',
    });
    expect(plan.actions).toEqual([{ kind: 'materialize-write', path: 'instructions/private.md', contentHash: newHash }]);
    const result = await applyMaterializeActions(project, stackHome, plan.actions, claudeHome);
    expect(result.written).toEqual(['instructions/private.md']);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path.join(projectDir, 'CLAUDE.local.md'), 'utf8')).toBe('private v2');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- canonical/project-sync.test.ts`
Expected: FAIL with a module-not-found error for `./project-sync.js`

- [ ] **Step 4: Implement `project-sync.ts`**

Create `packages/memory/src/canonical/project-sync.ts`:

```ts
import { readMemoryObject, writeMemoryObject } from '../store.js';
import {
  claudeNativeTargetOf,
  nativeRootsExist,
  scanClaudeProject,
  writeClaudeProject,
  type BoundProject,
  type MaterializeOp,
  type ScanResult,
} from './claude-project-adapter.js';
import { CANONICAL_MAIN_SCHEMA_VERSION, projectMemoryOf, type CanonicalDoc, type CanonicalMainManifest } from './domain.js';
import { namespaceOf } from './paths.js';
import { planSync, type NativeEntry, type SyncAction } from './sync.js';
import { readCanonicalMain, readProjection, writeCanonicalMain, writeProjection } from './store.js';

type ScanOptionsForAdapter = Parameters<typeof scanClaudeProject>[1];

export type ProjectSyncPlan = {
  actions: SyncAction[];
  sourceConflicts: { canonicalPath: string }[];
  guardedPaths: string[];
};

export const planProjectSync = async (
  project: BoundProject,
  stackHome: string,
  scanOptions: ScanOptionsForAdapter,
): Promise<ProjectSyncPlan> => {
  const claudeHome = (scanOptions as { claudeHome?: string }).claudeHome;
  const roots = await nativeRootsExist(project, claudeHome);
  if (!roots.projectDirExists) return { actions: [], sourceConflicts: [], guardedPaths: [] };

  const scanResult = await scanClaudeProject(project, scanOptions);
  const main = await readCanonicalMain(stackHome);
  const canonicalDocs = projectMemoryOf(main, project.projectId)?.documents ?? [];
  const projectionFile = await readProjection(stackHome, 'claude');
  const projection = projectionFile.projects[project.projectId] ?? {};

  const guardedPaths = roots.notesRootExists
    ? []
    : Object.keys(projection).filter((p) => namespaceOf(p) === 'notes');
  const effectiveProjection = guardedPaths.length === 0
    ? projection
    : Object.fromEntries(Object.entries(projection).filter(([p]) => !guardedPaths.includes(p)));

  const native: NativeEntry[] = scanResult.docs.map((d) => ({ path: d.canonicalPath, contentHash: d.contentHash }));
  const actions = planSync({ native, projection: effectiveProjection, canonical: canonicalDocs });
  return { actions, sourceConflicts: scanResult.sourceConflicts, guardedPaths };
};

const upsertDoc = (documents: CanonicalDoc[], doc: CanonicalDoc): CanonicalDoc[] => {
  const index = documents.findIndex((d) => d.path === doc.path);
  if (index === -1) return [...documents, doc];
  const next = [...documents];
  next[index] = doc;
  return next;
};

const withProjectDocuments = (
  main: CanonicalMainManifest,
  projectId: string,
  documents: CanonicalDoc[],
): CanonicalMainManifest => {
  const index = main.projects.findIndex((p) => p.projectId === projectId);
  if (index === -1) return { ...main, projects: [...main.projects, { projectId, documents }] };
  return { ...main, projects: main.projects.map((p, i) => (i === index ? { ...p, documents } : p)) };
};

/** Apply only the import-* actions from a plan (native -> canonical). Leaves
 * materialize-*/conflict actions untouched — those are the other command's job. */
export const applyImportActions = async (
  project: BoundProject,
  stackHome: string,
  scanResult: ScanResult,
  actions: SyncAction[],
): Promise<{ imported: string[] }> => {
  const bytesByPath = new Map(scanResult.docs.map((d) => [d.canonicalPath, d.bytes]));
  const main = await readCanonicalMain(stackHome);
  let documents = projectMemoryOf(main, project.projectId)?.documents ?? [];
  const projectionFile = await readProjection(stackHome, 'claude');
  const projection = { ...(projectionFile.projects[project.projectId] ?? {}) };
  const imported: string[] = [];
  const now = new Date().toISOString();

  for (const action of actions) {
    if (action.kind === 'import-edit') {
      const bytes = bytesByPath.get(action.path);
      if (!bytes) continue;
      await writeMemoryObject({ stackHome, contentHash: action.contentHash, bytes });
      documents = upsertDoc(documents, { path: action.path, state: 'present', contentHash: action.contentHash, importedFrom: 'claude', importedAt: now });
      projection[action.path] = action.contentHash;
      imported.push(action.path);
    } else if (action.kind === 'import-delete') {
      const lastContentHash = projection[action.path];
      if (lastContentHash === undefined) continue; // defensive; planSync never emits this without a known P
      documents = upsertDoc(documents, { path: action.path, state: 'deleted', lastContentHash, deletedAt: now });
      delete projection[action.path];
      imported.push(action.path);
    } else if (action.kind === 'already-synced') {
      projection[action.path] = action.contentHash;
    }
  }

  await writeCanonicalMain(stackHome, withProjectDocuments(main, project.projectId, documents));
  await writeProjection(stackHome, 'claude', { schemaVersion: 1, projects: { ...projectionFile.projects, [project.projectId]: projection } });
  return { imported };
};

/** Apply only the materialize-* actions from a plan (canonical -> native). */
export const applyMaterializeActions = async (
  project: BoundProject,
  stackHome: string,
  actions: SyncAction[],
  claudeHome?: string,
): Promise<{ written: string[]; deleted: string[] }> => {
  const projectionFile = await readProjection(stackHome, 'claude');
  const projection = { ...(projectionFile.projects[project.projectId] ?? {}) };
  const ops: MaterializeOp[] = [];
  for (const action of actions) {
    if (action.kind === 'materialize-write') {
      const bytes = await readMemoryObject({ stackHome, contentHash: action.contentHash });
      ops.push({ kind: 'write', canonicalPath: action.path, bytes });
      projection[action.path] = action.contentHash;
    } else if (action.kind === 'materialize-delete') {
      ops.push({ kind: 'delete', canonicalPath: action.path });
      delete projection[action.path];
    } else if (action.kind === 'already-synced') {
      projection[action.path] = action.contentHash;
    }
  }
  const result = claudeHome
    ? await writeClaudeProject(project, ops, claudeHome)
    : await writeClaudeProject(project, ops);
  await writeProjection(stackHome, 'claude', { schemaVersion: 1, projects: { ...projectionFile.projects, [project.projectId]: projection } });
  return result;
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- canonical/project-sync.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/memory/src/canonical/claude-project-adapter.ts packages/memory/src/canonical/project-sync.ts packages/memory/src/canonical/project-sync.test.ts
git commit -m "feat(memory): add project-sync orchestration with the mass-delete guard"
```

---

### Task 11: Fetch-remote-canonical bridge and bound-project enumeration

**Files:**
- Create: `packages/memory/src/canonical/fetch-remote-canonical.ts`
- Test: `packages/memory/src/canonical/fetch-remote-canonical.test.ts`
- Create: `packages/cli/src/memory/canonical-ops.ts`

**Interfaces:**
- Consumes: `type RemoteMemoryBackend`, `RemoteMemoryError` from `../remote/backend.js`; `open` from `../remote/cipher.js`; `unwrapDekWithMmk` from `../remote/mmk.js`; `parseBundle` from `../remote/bundle-codec.js`; `canonicalMainManifestSchema` from `./domain.js`; `convertV1Bundle` from `./convert-v1.js`; `type LocalRegistry` from `../project/registry.js`.
- Produces (`fetch-remote-canonical.ts`): `fetchRemoteCanonical(options: { backend: RemoteMemoryBackend; mmk?: Buffer; localRegistry: LocalRegistry }): Promise<{ generation: number; main: CanonicalMainManifest } | null>`.
- Produces (`canonical-ops.ts`): `type BoundProjectRecord = { projectId: string; dir: string }`, `listBoundProjects(stackHome: string): Promise<BoundProjectRecord[]>` (every registry binding, regardless of lifecycle — archived projects still sync, per spec), `resolveProjectIdForClaudeItem(item, registry): string | undefined` (re-exported wrapper around the existing `resolveCanonicalProjectId` from `packages/cli/src/memory/canonical-identity.ts`, so canonical-ops is the one place that bridges `@stack/memory`'s adapter-agnostic `resolveProjectId` callback to this CLI's already-proven identity resolution).

- [ ] **Step 1: Write the failing tests for `fetchRemoteCanonical`**

Create `packages/memory/src/canonical/fetch-remote-canonical.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryRemoteMemoryStore } from '../remote/backend.js';
import { bundleFromStoreForTest } from './test-helpers.js'; // see note below
import { fetchRemoteCanonical } from './fetch-remote-canonical.js';
import { emptyRegistry } from '../project/registry.js';

// This suite exercises fetchRemoteCanonical end-to-end against a real temp stackHome
// and the existing InMemoryRemoteMemoryBackend, reusing the SAME helper construction
// pattern already used in packages/memory/src/remote/modes.test.ts (read that file
// first and copy its exact backend/store setup rather than inventing a new one).
// Replace `bundleFromStoreForTest` above with that file's real import of
// `createInMemoryRemoteMemoryBackend`-equivalent helper and `standardCloudBackup`.

describe('fetchRemoteCanonical', () => {
  it('returns null when there is no Cloud generation yet', async () => {
    // backend with no generations
  });

  it('reads the canonical manifest directly from a v2 generation', async () => {
    // push a v2 bundle (canonical main present), then fetch and compare
  });

  it('falls back to convertV1Bundle for a v1 generation, using the provided localRegistry', async () => {
    // push a v1 bundle (no canonical main on disk when bundled), then fetch
  });
});
```

Because this module's only real complexity is "pick the decode path by `bundleFormat`, decrypt if Protected," write the real tests directly against `packages/memory/src/remote/modes.test.ts`'s existing fixtures rather than the placeholder sketch above — read that file first, copy its exact `InMemoryRemoteMemoryBackend` + temp-`stackHome` construction, and replace the three sketched tests with real assertions using `standardCloudBackup`/`protectedCloudBackup` to populate generations before calling `fetchRemoteCanonical`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stack/memory test -- canonical/fetch-remote-canonical.test.ts`
Expected: FAIL with a module-not-found error for `./fetch-remote-canonical.js`

- [ ] **Step 3: Implement `fetch-remote-canonical.ts`**

Create `packages/memory/src/canonical/fetch-remote-canonical.ts`:

```ts
import { open } from '../remote/cipher.js';
import { unwrapDekWithMmk } from '../remote/mmk.js';
import { parseBundle } from '../remote/bundle-codec.js';
import { RemoteMemoryError, type RemoteMemoryBackend } from '../remote/backend.js';
import { hashBytes } from '../store.js';
import type { LocalRegistry } from '../project/registry.js';
import { convertV1Bundle } from './convert-v1.js';
import { canonicalMainManifestSchema, emptyCanonicalMain, type CanonicalMainManifest } from './domain.js';

const splitPayload = (payload: Uint8Array) => {
  const buf = Buffer.from(payload);
  return { nonce: buf.subarray(0, 12), ciphertext: buf.subarray(12, buf.length - 16), tag: buf.subarray(buf.length - 16) };
};

const protectedAad = (backupId: string): Buffer =>
  Buffer.from(JSON.stringify({ v: 1, mode: 'protected', backupId }), 'utf8');

/** Fetch Cloud's latest generation and decode it into canonical Memory — reading
 * `canonicalB64` directly for a v2 generation, or deterministically converting a
 * v1 generation via `convertV1Bundle`. `localRegistry` is used ONLY as the v1
 * fallback's identity source (spec section 9.2). */
export const fetchRemoteCanonical = async (options: {
  backend: RemoteMemoryBackend;
  mmk?: Buffer;
  localRegistry: LocalRegistry;
}): Promise<{ generation: number; main: CanonicalMainManifest } | null> => {
  const meta = await options.backend.getLatest();
  if (!meta) return null;
  const payload = await options.backend.getPayload(meta.backupId);
  if (hashBytes(payload) !== meta.payloadSha256)
    throw new RemoteMemoryError('integrity', 'Payload failed its integrity hash.');

  let bundleBytes: Uint8Array;
  if (meta.privacyMode === 'standard') {
    bundleBytes = payload;
  } else {
    if (!options.mmk) throw new RemoteMemoryError('mmk-required', 'Protected recovery requires the Memory Master Key.');
    if (!meta.wrappedDek) throw new RemoteMemoryError('not-protected', 'Protected generation is missing its wrapped DEK.');
    const dek = unwrapDekWithMmk(meta.wrappedDek, options.mmk, meta.backupId);
    bundleBytes = open(splitPayload(payload), dek, protectedAad(meta.backupId));
  }

  const bundle = parseBundle(bundleBytes);
  const main = bundle.canonicalB64
    ? canonicalMainManifestSchema.parse(JSON.parse(Buffer.from(bundle.canonicalB64, 'base64').toString('utf8')))
    : convertV1Bundle(bundle, { localRegistry: options.localRegistry });
  return { generation: meta.generation, main: main ?? emptyCanonicalMain() };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @stack/memory test -- canonical/fetch-remote-canonical.test.ts`
Expected: PASS

- [ ] **Step 5: Implement `canonical-ops.ts` in the CLI package**

Create `packages/cli/src/memory/canonical-ops.ts`:

```ts
import {
  readLocalRegistry,
  type DiscoveredMemoryItem,
  type LocalRegistry,
  type ManifestItem,
} from '@stack/memory';

import { resolveCanonicalProjectId } from './canonical-identity.js';

export type BoundProjectRecord = { projectId: string; dir: string };

/** Every machine-local binding this registry knows, regardless of lifecycle —
 * archived projects still sync their Memory (spec: "preserved regardless of
 * lifecycle"). */
export const listBoundProjects = async (stackHome: string): Promise<BoundProjectRecord[]> => {
  const registry = await readLocalRegistry(stackHome);
  return registry.bindings.map((binding) => ({ projectId: binding.projectId, dir: binding.dir }));
};

/** The `resolveProjectId` callback the canonical scan/migration functions expect,
 * wired to this CLI's already-proven identity resolution (`canonical-identity.ts`,
 * unchanged by this feature) so `@stack/memory` itself never depends on it. */
export const resolveProjectIdForClaudeItem = (
  item: Pick<DiscoveredMemoryItem | ManifestItem, 'project' | 'kind' | 'logicalId' | 'restoreTarget'>,
  registry: LocalRegistry,
): string | undefined => resolveCanonicalProjectId(item, registry);
```

- [ ] **Step 6: Run the CLI package's existing test suite to confirm no regressions**

Run: `pnpm --filter @stack/cli test`
Expected: PASS (this step only adds new exports; nothing existing is modified yet)

- [ ] **Step 7: Commit**

```bash
git add packages/memory/src/canonical/fetch-remote-canonical.ts packages/memory/src/canonical/fetch-remote-canonical.test.ts packages/cli/src/memory/canonical-ops.ts
git commit -m "feat(memory): bridge Cloud generations to canonical Memory and enumerate bound projects"
```

---

### Task 12: Wire canonical Memory into `stak status` and `stak add .`

**Files:**
- Modify: `packages/cli/src/memory/stage-memory.ts` (scope its native discovery to global-only, since project-scope Memory now belongs to canonical)
- Modify: `packages/cli/src/memory/canonical-ops.ts`
- Test: `packages/cli/src/memory/canonical-ops.test.ts`
- Modify: `packages/cli/src/ui/add.ts` (extend `StagedMemorySummary`)
- Modify: `packages/cli/src/ui/environment.ts` (extend `MemoryWorkingTreeStatus` rendering)
- Modify: `packages/cli/src/memory/working-tree-status.ts` (add a canonical status variant)
- Modify: `packages/cli/src/program.ts` (wire `stageMemory`/`checkMemory` dependencies)

**Interfaces:**
- Produces (`canonical-ops.ts`, additive): `type CanonicalProjectSummary = { projectId: string; imported: string[]; conflicts: { path: string; reason: string }[]; sourceConflicts: string[]; guardedPaths: string[] }`, `stageCanonicalMemory(stackHome: string): Promise<CanonicalProjectSummary[]>` (runs `migrateLocalStore` once, then `planProjectSync` + `applyImportActions` for every bound project), `canonicalMemoryStatus(stackHome: string): Promise<CanonicalProjectSummary[]>` (same plan, read-only — never calls `applyImportActions`).
- Produces (`working-tree-status.ts`, additive): a new exported type `CanonicalMemoryWorkingTreeStatus = { projects: CanonicalProjectSummaryLike[] }` re-exporting the shape above, consumed by `ui/environment.ts`.

- [ ] **Step 1: Scope `stageMemoryWithProjectDedup`'s native discovery to global-only**

In `packages/cli/src/memory/stage-memory.ts`, after the `nativeItems` discovery call, filter to global scope before reconciling/backing up (project-scope Memory is now owned by canonical Memory — staging it into the v1 manifest would re-pollute `current.json` after migration, contradicting spec section 9.1 step 5):

```ts
const nativeItems = (
  await discoverClaudeMemory({
    ...options,
    onLocalProjectResolved: (vendorKey, dir) => {
      const base = safeDirectoryBasename(dir);
      if (base) nameHints.set(vendorKey, base);
    },
  })
).filter((item) => item.scope === 'global'); // project-scope Memory now goes through canonical staging (stageCanonicalMemory), not this v1 path.
```

Run `pnpm --filter @stack/cli test -- stage-memory` (or whatever this file's existing test command is — check `packages/cli/package.json`'s `test` script) and update any existing test that asserted project-scope items land in the v1 manifest; those assertions are now wrong by design — change them to assert the project-scope item is EXCLUDED and the global one still stages normally.

- [ ] **Step 2: Write the failing tests for `stageCanonicalMemory`/`canonicalMemoryStatus`**

Create `packages/cli/src/memory/canonical-ops.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setBinding, writeLocalRegistry, readLocalRegistry, resolveOrMintProject } from '@stack/memory';

import { canonicalMemoryStatus, stageCanonicalMemory } from './canonical-ops.js';

let root: string;
let stackHome: string;
let claudeHome: string;
let projectDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'stak-canonical-ops-'));
  stackHome = path.join(root, 'stack-home');
  claudeHome = path.join(root, '.claude');
  projectDir = path.join(root, 'proj');
  await mkdir(projectDir, { recursive: true });
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const bindProject = async (dir: string) => {
  let registry = await readLocalRegistry(stackHome);
  const minted = resolveOrMintProject(registry, { kind: 'local', vendorKey: `v-${path.basename(dir)}` });
  registry = setBinding(minted.registry, { projectId: minted.projectId, dir, boundAt: '2026-10-22T00:00:00.000Z', provenance: 'user-map' });
  await writeLocalRegistry(stackHome, registry);
  return minted.projectId;
};

describe('stageCanonicalMemory', () => {
  it('imports a native edit for a bound project and reports it', async () => {
    const projectId = await bindProject(projectDir);
    await mkdir(path.dirname(path.join(projectDir, 'CLAUDE.local.md')), { recursive: true });
    await writeFile(path.join(projectDir, 'CLAUDE.local.md'), 'private memory');

    const summaries = await stageCanonicalMemory(stackHome, { claudeHome });
    const mine = summaries.find((s) => s.projectId === projectId);
    expect(mine?.imported).toContain('instructions/private.md');
  });

  it('is read-only in canonicalMemoryStatus (does not import)', async () => {
    const projectId = await bindProject(projectDir);
    await writeFile(path.join(projectDir, 'CLAUDE.local.md'), 'private memory');

    const summaries = await canonicalMemoryStatus(stackHome, { claudeHome });
    expect(summaries.find((s) => s.projectId === projectId)?.imported).toEqual([]);
    // Confirm nothing was actually staged.
    const after = await canonicalMemoryStatus(stackHome, { claudeHome });
    expect(after.find((s) => s.projectId === projectId)?.imported).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @stack/cli test -- canonical-ops.test.ts`
Expected: FAIL — `stageCanonicalMemory`/`canonicalMemoryStatus` are not exported yet

- [ ] **Step 4: Implement `stageCanonicalMemory`/`canonicalMemoryStatus`**

Append to `packages/cli/src/memory/canonical-ops.ts`:

```ts
import {
  migrateLocalStore,
  planProjectSync,
  applyImportActions,
  readLocalRegistry,
  type ScanResult,
  type DiscoveredMemoryItem,
} from '@stack/memory';
import { scanClaudeProject } from '@stack/memory';

export type CanonicalProjectSummary = {
  projectId: string;
  imported: string[];
  conflicts: { path: string; reason: string }[];
  sourceConflicts: string[];
  guardedPaths: string[];
};

const planAllBoundProjects = async (
  stackHome: string,
  options: { claudeHome?: string } = {},
): Promise<Array<{ projectId: string; dir: string; plan: Awaited<ReturnType<typeof planProjectSync>>; scanResult: ScanResult }>> => {
  const bound = await listBoundProjects(stackHome);
  const registry = await readLocalRegistry(stackHome);
  const out = [];
  for (const { projectId, dir } of bound) {
    const scanOptions = {
      ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
      projects: [{ dir }],
      resolveProjectId: (item: DiscoveredMemoryItem) => resolveProjectIdForClaudeItem(item, registry),
    };
    const plan = await planProjectSync({ projectId, dir }, stackHome, scanOptions);
    const scanResult = await scanClaudeProject({ projectId, dir }, scanOptions);
    out.push({ projectId, dir, plan, scanResult });
  }
  return out;
};

const toSummary = (entry: Awaited<ReturnType<typeof planAllBoundProjects>>[number], imported: string[]): CanonicalProjectSummary => ({
  projectId: entry.projectId,
  imported,
  conflicts: entry.plan.actions
    .filter((a): a is Extract<typeof a, { kind: 'conflict' }> => a.kind === 'conflict')
    .map((a) => ({ path: a.path, reason: a.reason })),
  sourceConflicts: entry.plan.sourceConflicts.map((c) => c.canonicalPath),
  guardedPaths: entry.plan.guardedPaths,
});

/** Read-only: plans every bound project's sync but never imports. */
export const canonicalMemoryStatus = async (
  stackHome: string,
  options: { claudeHome?: string } = {},
): Promise<CanonicalProjectSummary[]> => {
  const entries = await planAllBoundProjects(stackHome, options);
  return entries.map((entry) => toSummary(entry, []));
};

/** `stak add .`'s canonical-Memory half: migrate once, then import every bound
 * project's native edits into canonical Memory. */
export const stageCanonicalMemory = async (
  stackHome: string,
  options: { claudeHome?: string } = {},
): Promise<CanonicalProjectSummary[]> => {
  await migrateLocalStore(stackHome);
  const entries = await planAllBoundProjects(stackHome, options);
  const summaries: CanonicalProjectSummary[] = [];
  for (const entry of entries) {
    const { imported } = await applyImportActions({ projectId: entry.projectId, dir: entry.dir }, stackHome, entry.scanResult, entry.plan.actions);
    summaries.push(toSummary(entry, imported));
  }
  return summaries;
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @stack/cli test -- canonical-ops.test.ts`
Expected: PASS

- [ ] **Step 6: Extend `StagedMemorySummary` and wire `add.ts`'s `stageMemory` dependency**

In `packages/cli/src/ui/add.ts`, widen the type and render a line per project with conflicts/guarded paths:

```ts
export type StagedMemorySummary = {
  files: number;
  projects: number;
  canonical?: Array<{ projectId: string; imported: number; conflicts: number; guarded: number }>;
};
```

Add a short block in `renderSkillAdd` (follow the file's existing `lines.push(...)` style exactly) after the existing Memory summary lines:

```ts
if (options.memory?.canonical?.length) {
  for (const project of options.memory.canonical) {
    if (project.imported > 0) lines.push(`  Memory: imported ${project.imported} change(s) for ${project.projectId}`);
    if (project.conflicts > 0) lines.push(`  Memory: ${project.conflicts} conflict(s) in ${project.projectId} — resolve with \`stak memory resolve\``);
    if (project.guarded > 0) lines.push(`  Memory: ${project.guarded} path(s) will be regenerated for ${project.projectId} — run \`stak memory materialize\``);
  }
}
```

In `packages/cli/src/program.ts`, find where `stageMemory` is currently wired for the `add` command's dependencies (search for `stageMemoryWithProjectDedup` — it is passed as `stageMemory` to `registerAddCommand`'s dependencies). Change it to call both the existing global staging AND the new canonical staging, combining their results:

```ts
stageMemory: async () => {
  const legacy = await stageMemoryWithProjectDedup({ stackHome, claudeHome, projects, now, gitRemoteOf, isDirectory });
  const canonical = await stageCanonicalMemory(stackHome, { claudeHome });
  return {
    files: legacy.files,
    projects: legacy.projects,
    canonical: canonical.map((p) => ({
      projectId: p.projectId,
      imported: p.imported.length,
      conflicts: p.conflicts.length + p.sourceConflicts.length,
      guarded: p.guardedPaths.length,
    })),
  };
},
```

Match this against the EXACT existing call site (same variable names for `claudeHome`/`projects`/`now`/`gitRemoteOf`/`isDirectory` as the current `stageMemoryWithProjectDedup` call already uses there — do not rename anything, only add the `stageCanonicalMemory` call and the combined return).

- [ ] **Step 7: Extend `stak status` similarly**

In `packages/cli/src/memory/working-tree-status.ts`, add (additive, does not change the existing `MemoryWorkingTreeStatus` union):

```ts
export type { CanonicalProjectSummary as CanonicalMemoryProjectStatus } from './canonical-ops.js';
```

In `packages/cli/src/ui/environment.ts`, find `renderStatus`'s Memory section (search for where `MemoryWorkingTreeStatus`'s `state` is rendered) and add an analogous block for canonical project summaries, following that function's existing formatting style — render one line per project that has any `conflicts`, `sourceConflicts`, or `guardedPaths`, otherwise nothing (clean status stays silent, matching the file's existing convention for the `'clean'` state).

In `packages/cli/src/program.ts`, find the `checkMemory` dependency wired to `registerStatusCommand` (search for `computeMemoryWorkingTreeStatus`) and add a sibling call to `canonicalMemoryStatus(stackHome, { claudeHome })`, passed through to `dependencies.checkMemory`'s return value as an added field (extend `MemoryWorkingTreeStatus`'s call site locally — the type itself stays a union of its existing three variants, but the object returned to `renderStatus` carries an additional `canonicalProjects` field read by the `ui/environment.ts` block added above). Never let a canonical status failure break `stak status`: wrap the `canonicalMemoryStatus` call exactly like the existing `checkMemory`/`checkCloud` dependencies are wrapped in `program.ts` (catch and fall back to `[]`).

- [ ] **Step 8: Run the full CLI test suite**

Run: `pnpm --filter @stack/cli test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/memory/stage-memory.ts packages/cli/src/memory/canonical-ops.ts packages/cli/src/memory/canonical-ops.test.ts packages/cli/src/ui/add.ts packages/cli/src/ui/environment.ts packages/cli/src/memory/working-tree-status.ts packages/cli/src/program.ts
git commit -m "feat(cli): wire canonical Project Memory into stak status and stak add ."
```

---

### Task 13: Wire canonical Memory into `stak push` and `stak pull`

**Important:** this task REPLACES the Memory half of `stak push`'s wiring (`applyMemoryPush` in `packages/cli/src/program.ts`), it does not add a second upload path alongside it. Once canonical Memory exists (which it now always does — any Memory-touching command runs `migrateLocalStore` first per Task 12), a v2 bundle already carries both the global v1 manifest and canonical Memory together, so there must be exactly ONE `createGeneration` call per `stak push`. The old `pushStagedMemory`/`resolveMemoryPushState` functions (`packages/cli/src/memory/cloud-ops.ts`) become unused by `stak push` after this task — leave them in place (do not delete; `stak memory backup`'s own command currently has independent wiring through `runMemoryCloudBackup`, which this task also repoints, per spec section 9.3's "`memory backup` stays as a deprecated alias") rather than removing exported functions mid-feature.

**Files:**
- Modify: `packages/cli/src/memory/cloud-ops.ts` (add `publishCanonicalGeneration`, repoint `runMemoryCloudBackup`'s Cloud branch)
- Modify: `packages/cli/src/memory/canonical-ops.ts` (add `pushMemoryViaCanonical`, `pullMemoryViaCanonical`)
- Test: `packages/cli/src/memory/canonical-ops.test.ts` (add cases)
- Modify: `packages/cli/src/program.ts` (repoint `applyMemoryPush`, add `applyCanonicalPull`)
- Modify: `packages/cli/src/commands/pull.ts` (add the `applyCanonicalPull` dependency)
- Modify: `packages/cli/src/ui/cloud.ts` (render canonical push/pull outcomes)

**Interfaces:**
- Produces (`cloud-ops.ts`, additive): `publishCanonicalGeneration(deps: MemoryCloudDeps, main: CanonicalMainManifest): Promise<{ generation: number }>` — mirrors `pushStagedMemory`'s mode check + `standardCloudBackup`/`protectedCloudBackup` + `recordRecoveryProvenance`, but NEVER swallows a thrown `RemoteMemoryError` (push.ts's retry loop needs to see `code: 'conflict'` propagate, not be flattened into a `{status:'failed'}` result the way `pushStagedMemory` does for its own unrelated callers).
- Produces (`canonical-ops.ts`, additive): `type CanonicalPushOutcome = { status: 'up-to-date' | 'pushed' | 'conflict' | 'retry-exhausted'; generation?: number; conflicts?: { projectId: string; path: string; reason: string }[] }`, `pushMemoryViaCanonical(deps: MemoryCloudDeps): Promise<CanonicalPushOutcome>` (runs `pushCanonicalMemory`, Task 9; materializes on any non-conflict outcome), `type CanonicalPullOutcome = { status: 'up-to-date' | 'merged' | 'conflict'; conflicts?: { projectId: string; path: string; reason: string }[] }`, `pullMemoryViaCanonical(deps: MemoryCloudDeps): Promise<CanonicalPullOutcome>` (runs `pullCanonicalMemory`, Task 9A; materializes on any non-conflict outcome).

- [ ] **Step 1: Add `publishCanonicalGeneration` to `cloud-ops.ts`**

In `packages/cli/src/memory/cloud-ops.ts`, right after `pushStagedMemory`'s definition, add:

```ts
import { writeCanonicalMain, type CanonicalMainManifest } from '@stack/memory';

/**
 * Upload exactly one new Cloud generation built from `main` (already written to
 * `canonical/main.json` by this function before bundling). Unlike `pushStagedMemory`,
 * this lets any thrown error (including `RemoteMemoryError('conflict', ...)`)
 * propagate — `pushCanonicalMemory`'s retry loop (Task 9) depends on seeing that
 * error, not a swallowed `{status:'failed'}` result.
 */
export const publishCanonicalGeneration = async (
  deps: MemoryCloudDeps,
  main: CanonicalMainManifest,
): Promise<{ generation: number }> => {
  await writeCanonicalMain(deps.stackHome, main);
  if (!deps.backend) throw new Error('No Cloud backend configured.');
  const semanticDigest = await computeSemanticDigest(deps.stackHome);
  const profile = await deps.backend.getProfile();
  const mode = profile?.privacyMode ?? 'standard';
  if (mode === 'protected') {
    const mmk = await deps.localKeyStore.loadMmk();
    if (!mmk) throw new Error('Protected Memory is locked on this machine.');
    const result = await protectedCloudBackup({ stackHome: deps.stackHome, backend: deps.backend, mmk, ...(deps.now ? { now: deps.now } : {}) });
    await recordRecoveryProvenance(deps, { generation: result.generation, privacyMode: 'protected', cloudLatest: result.generation, ...(semanticDigest ? { semanticDigest } : {}) });
    return { generation: result.generation };
  }
  const result = await standardCloudBackup({ stackHome: deps.stackHome, backend: deps.backend, ...(deps.now ? { now: deps.now } : {}) });
  await recordRecoveryProvenance(deps, { generation: result.generation, privacyMode: 'standard', cloudLatest: result.generation, ...(semanticDigest ? { semanticDigest } : {}) });
  return { generation: result.generation };
};
```

`recordRecoveryProvenance` and `computeSemanticDigest` are already private to this file and usable here unchanged.

- [ ] **Step 2: Run the existing cloud-ops test suite to confirm no regressions**

Run: `pnpm --filter @stack/cli test -- cloud-ops`
Expected: PASS (additive change only)

- [ ] **Step 3: Write the failing tests for `pushMemoryViaCanonical`/`pullMemoryViaCanonical`**

Append to `packages/cli/src/memory/canonical-ops.test.ts` (reuse this file's existing temp-dir + `bindProject` helpers from Task 12's tests; construct `MemoryCloudDeps` the same way `packages/cli/src/memory/cloud-ops.test.ts` already does — read that file first and copy its exact in-memory backend + `MemoryCloudDeps` construction rather than inventing a new one):

```ts
import { pullMemoryViaCanonical, pushMemoryViaCanonical } from './canonical-ops.js';

describe('pushMemoryViaCanonical and pullMemoryViaCanonical', () => {
  it('pushes a native edit, then a second machine pulling sees it materialized', async () => {
    // 1. Machine A: bind a project, write a native edit, stage it, push it.
    //    (construct deps for machine A exactly as cloud-ops.test.ts's own push tests do,
    //    sharing one InMemoryRemoteMemoryStore so machine B's backend sees machine A's upload)
    // 2. Machine B: bind the SAME project id to a different local directory, pull.
    // 3. Assert machine B's project directory now has the native file materialized.
    //
    // This test's exact construction must mirror cloud-ops.test.ts's existing
    // two-machine Cloud fixtures (search that file for `InMemoryRemoteMemoryStore` to
    // find the established pattern) rather than being written from scratch here.
  });
});
```

Because this scenario depends entirely on `cloud-ops.test.ts`'s existing two-machine fixture helpers (not yet read in this plan), write the actual test body by copying that file's established construction pattern verbatim and adapting only the final assertions to canonical Memory (native file content), rather than inventing new backend/registry wiring.

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @stack/cli test -- canonical-ops.test.ts`
Expected: FAIL — `pushMemoryViaCanonical`/`pullMemoryViaCanonical` are not exported yet

- [ ] **Step 5: Implement `pushMemoryViaCanonical`/`pullMemoryViaCanonical`**

Append to `packages/cli/src/memory/canonical-ops.ts`:

```ts
import {
  pushCanonicalMemory,
  pullCanonicalMemory,
  fetchRemoteCanonical,
  readCanonicalMain,
  readCanonicalBase,
  writeCanonicalMain,
  writeCanonicalBase,
  writePendingMerge,
  clearPendingMerge,
  applyMaterializeActions,
  planProjectSync,
} from '@stack/memory';
import { publishCanonicalGeneration, type MemoryCloudDeps } from './cloud-ops.js';

export type CanonicalConflictEntry = { projectId: string; path: string; reason: string };
export type CanonicalPushOutcome = {
  status: 'up-to-date' | 'pushed' | 'conflict' | 'retry-exhausted';
  generation?: number;
  conflicts?: CanonicalConflictEntry[];
};
export type CanonicalPullOutcome = {
  status: 'up-to-date' | 'merged' | 'conflict';
  conflicts?: CanonicalConflictEntry[];
};

/** Materialize canonical Memory into every bound project's native files. Never
 * uploads anything — safe to call after push, pull, or on its own (`stak memory
 * materialize`, Task 14). */
const materializeAllBoundProjects = async (deps: { stackHome: string; claudeHome?: string }): Promise<void> => {
  const bound = await listBoundProjects(deps.stackHome);
  const registry = await readLocalRegistry(deps.stackHome);
  for (const { projectId, dir } of bound) {
    const scanOptions = {
      ...(deps.claudeHome ? { claudeHome: deps.claudeHome } : {}),
      projects: [{ dir }],
      resolveProjectId: (item: DiscoveredMemoryItem) => resolveProjectIdForClaudeItem(item, registry),
    };
    const plan = await planProjectSync({ projectId, dir }, deps.stackHome, scanOptions);
    await applyMaterializeActions({ projectId, dir }, deps.stackHome, plan.actions, deps.claudeHome);
  }
};

const remoteOf = (deps: MemoryCloudDeps, mmk: Buffer | undefined) => async () =>
  deps.backend
    ? fetchRemoteCanonical({ backend: deps.backend, ...(mmk ? { mmk } : {}), localRegistry: await readLocalRegistry(deps.stackHome) })
    : null;

export const pushMemoryViaCanonical = async (deps: MemoryCloudDeps): Promise<CanonicalPushOutcome> => {
  if (!deps.backend) return { status: 'up-to-date' };
  const mmk = deps.localKeyStore ? await deps.localKeyStore.loadMmk().catch(() => undefined) : undefined;
  const outcome = await pushCanonicalMemory({
    getLocalMain: () => readCanonicalMain(deps.stackHome),
    getBase: () => readCanonicalBase(deps.stackHome),
    setBase: (base) => writeCanonicalBase(deps.stackHome, base),
    fetchRemote: remoteOf(deps, mmk),
    publish: (main) => publishCanonicalGeneration(deps, main),
    savePendingMerge: (pending) => writePendingMerge(deps.stackHome, pending),
    clearPendingMerge: () => clearPendingMerge(deps.stackHome),
  });
  if (outcome.status === 'pushed' || outcome.status === 'up-to-date') await materializeAllBoundProjects(deps);
  return outcome;
};

export const pullMemoryViaCanonical = async (deps: MemoryCloudDeps): Promise<CanonicalPullOutcome> => {
  if (!deps.backend) return { status: 'up-to-date' };
  const mmk = deps.localKeyStore ? await deps.localKeyStore.loadMmk().catch(() => undefined) : undefined;
  const outcome = await pullCanonicalMemory({
    getLocalMain: () => readCanonicalMain(deps.stackHome),
    getBase: () => readCanonicalBase(deps.stackHome),
    setLocalMain: (main) => writeCanonicalMain(deps.stackHome, main),
    setBase: (base) => writeCanonicalBase(deps.stackHome, base),
    fetchRemote: remoteOf(deps, mmk),
    savePendingMerge: (pending) => writePendingMerge(deps.stackHome, pending),
    clearPendingMerge: () => clearPendingMerge(deps.stackHome),
  });
  if (outcome.status !== 'conflict') await materializeAllBoundProjects(deps);
  return outcome.status === 'merged-local'
    ? { status: 'merged' }
    : outcome.status === 'conflict'
      ? { status: 'conflict', conflicts: outcome.conflicts }
      : { status: 'up-to-date' };
};
```

Note: `publishCanonicalGeneration` (Step 1) ignores its `expectedParent` parameter from `pushCanonicalMemory`'s call signature other than relying on `standardCloudBackup`/`protectedCloudBackup` to read Cloud's actual current latest internally and pass it as their own `expectedParent` — since `pushCanonicalMemory` already re-fetched remote immediately before calling `publish` in every code path, these two reads of "current latest" are close enough in time that a real race is caught by `createGeneration`'s own check and surfaces as the thrown `RemoteMemoryError('conflict', ...)` `pushCanonicalMemory`'s retry loop already expects — no separate manual `expectedParent` comparison is needed in `publishCanonicalGeneration` itself.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @stack/cli test -- canonical-ops.test.ts`
Expected: PASS

- [ ] **Step 7: Repoint `stak push`'s Memory wiring in `program.ts`**

In `packages/cli/src/program.ts`, replace the `applyMemoryPush` implementation shown above with:

```ts
applyMemoryPush: async () => {
  const deps = await buildMemoryCloudDeps();
  const outcome = await pushMemoryViaCanonical(deps);
  if (outcome.status === 'conflict')
    throw new LocalEnvironmentConflictError(
      `Memory has ${outcome.conflicts?.length ?? 0} unresolved conflict(s). Resolve with \`stak memory resolve\`, then push again.`,
    );
  if (outcome.status === 'retry-exhausted')
    throw new StackCompositionError('memory-push-retry-exhausted', 'STAK Cloud kept moving while pushing Memory. Try again.');
  return outcome.status === 'up-to-date'
    ? { status: 'up-to-date', generation: outcome.generation ?? 0 }
    : { status: 'standard', generation: outcome.generation ?? 0 };
},
```

Remove the now-unused `resolveMemoryPushState`/`pushStagedMemory` import names from this call site only if nothing else in `program.ts` still references them (grep first — `memoryCloudBackup`'s wiring, touched in Step 8 below, may still need `pushStagedMemory`'s sibling logic indirectly through `runMemoryCloudBackup`, so check before removing any import).

- [ ] **Step 8: Repoint `stak memory backup`'s Cloud branch**

In `packages/cli/src/memory/cloud-ops.ts`, find `runMemoryCloudBackup`'s Cloud branch (the part that currently calls the Cloud upload after the local backup). Change it to call `publishCanonicalGeneration(deps, await readCanonicalMain(deps.stackHome))` directly (after ensuring `migrateLocalStore(deps.stackHome)` has run — add that call at the top of `runMemoryCloudBackup`, matching spec section 9.3's "stays as a deprecated alias for the Memory part of `stak push`", meaning it now ALSO goes through migration + the same canonical publish path, just always creating a generation rather than checking up-to-date first — preserve that one behavioral difference, since it is explicitly called out as intentional and unchanged in this file's existing comments).

- [ ] **Step 9: Run the full CLI test suite**

Run: `pnpm --filter @stack/cli test`
Expected: PASS — update any test that asserted the old `pushStagedMemory`/`resolveMemoryPushState` call sites directly (they are now called `publishCanonicalGeneration`/`pushMemoryViaCanonical`); do not weaken assertions, just repoint them to the new function names with equivalent behavior.

- [ ] **Step 10: Wire `stak pull`'s canonical Memory dependency**

In `packages/cli/src/commands/pull.ts`, add `applyCanonicalPull?(): Promise<CanonicalPullOutcome>` to `PullCommandDependencies` and call it unconditionally (not gated by `memoryPullPreflight`, which stays exactly as-is for the old fresh-machine full-recover path) right after the existing `applyMemoryPull` branch, wrapping failures the same defensive way `checkCloud`/`checkMemory` are wrapped elsewhere in this package (never let it throw past this command). In `packages/cli/src/program.ts`, wire `applyCanonicalPull: () => pullMemoryViaCanonical(buildMemoryCloudDeps())`.

- [ ] **Step 11: Render canonical outcomes**

In `packages/cli/src/ui/cloud.ts`, find `renderCombinedPushResult`/`renderCombinedPullResult` and add a short line for a non-`up-to-date` canonical outcome (conflict count, or "Memory synced." for `pushed`), following this file's existing terse formatting style exactly — do not add new sections, just append one line consistent with how the existing Skill/Memory lines already read.

- [ ] **Step 12: Run the full CLI test suite one more time**

Run: `pnpm --filter @stack/cli test`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add packages/memory/src/canonical/push.ts packages/memory/src/canonical/push.test.ts packages/cli/src/memory/cloud-ops.ts packages/cli/src/memory/canonical-ops.ts packages/cli/src/memory/canonical-ops.test.ts packages/cli/src/program.ts packages/cli/src/commands/pull.ts packages/cli/src/ui/cloud.ts
git commit -m "feat(cli): wire canonical Project Memory into stak push and stak pull"
```

---

### Task 14: `stak memory resolve`, `stak memory diff`, `stak memory materialize`

**Files:**
- Modify: `packages/memory/src/canonical/fetch-remote-canonical.ts` (accept an explicit generation)
- Modify: `packages/cli/src/memory/canonical-ops.ts` (add `resolvePendingConflict`, `diffPendingConflict`, `materializeProject`)
- Test: `packages/cli/src/memory/canonical-ops.test.ts` (add cases)
- Modify: `packages/cli/src/commands/memory.ts`
- Modify: `packages/cli/src/program.ts`

**Interfaces:**
- Produces (`fetch-remote-canonical.ts`, modified): `fetchRemoteCanonical(options: { backend; mmk?; localRegistry; generation?: number })` — when `generation` is given, reads that specific (immutable) generation via `backend.getGeneration(generation)` instead of `getLatest()`.
- Produces (`canonical-ops.ts`, additive): `type PendingConflictSummary = { projectId: string; path: string; reason: string }`, `listPendingConflicts(stackHome: string): Promise<PendingConflictSummary[]>`, `resolvePendingConflict(stackHome: string, projectId: string, path: string, keep: 'local' | 'cloud' | 'both'): Promise<{ resolvedPath: string; altPath?: string }>`, `diffPendingConflict(stackHome: string, projectId: string, path: string): Promise<{ local: string; cloud: string }>` (decoded UTF-8 text for display — Memory documents are Markdown), `materializeProject(stackHome: string, projectId: string, claudeHome?: string): Promise<{ written: string[]; deleted: string[] }>`.

- [ ] **Step 1: Extend `fetchRemoteCanonical` to read a specific generation**

In `packages/memory/src/canonical/fetch-remote-canonical.ts`, change the signature and its one call site:

```ts
export const fetchRemoteCanonical = async (options: {
  backend: RemoteMemoryBackend;
  mmk?: Buffer;
  localRegistry: LocalRegistry;
  generation?: number;
}): Promise<{ generation: number; main: CanonicalMainManifest } | null> => {
  const meta =
    options.generation !== undefined
      ? await options.backend.getGeneration(options.generation)
      : await options.backend.getLatest();
  if (!meta) return null;
  /* ...rest unchanged... */
```

Run `pnpm --filter @stack/memory test -- canonical/fetch-remote-canonical.test.ts` — Expected: PASS (additive, optional field).

- [ ] **Step 2: Write the failing tests for conflict listing/resolving/diffing**

Append to `packages/cli/src/memory/canonical-ops.test.ts`:

```ts
import { writeCanonicalBase, writeCanonicalMain, writePendingMerge, readCanonicalMain } from '@stack/memory';
import { diffPendingConflict, listPendingConflicts, resolvePendingConflict } from './canonical-ops.js';

const h = (n: number) => `sha256:${n.toString().padStart(64, '0')}`;

describe('resolvePendingConflict', () => {
  it('keeps local, flushing the resolved document into canonical main and clearing the pending merge', async () => {
    const stackHome = path.join(root, 'stack-home-2');
    await writeCanonicalMain(stackHome, {
      schemaVersion: 2,
      projects: [{ projectId: 'prj_x', documents: [{ path: 'notes/a.md', state: 'present', contentHash: h(2), importedFrom: 'claude', importedAt: '2026-10-22T00:00:00.000Z' }] }],
    });
    await writePendingMerge(stackHome, {
      basedOnGeneration: 4,
      merged: { schemaVersion: 2, projects: [{ projectId: 'prj_x', documents: [] }] },
      conflicts: [{ projectId: 'prj_x', path: 'notes/a.md', reason: 'edit-edit' }],
    });

    expect(await listPendingConflicts(stackHome)).toEqual([{ projectId: 'prj_x', path: 'notes/a.md', reason: 'edit-edit' }]);
    await resolvePendingConflict(stackHome, 'prj_x', 'notes/a.md', 'local');

    const main = await readCanonicalMain(stackHome);
    expect(main.projects[0]?.documents.find((d) => d.path === 'notes/a.md')).toMatchObject({ contentHash: h(2) });
    expect(await listPendingConflicts(stackHome)).toEqual([]);
  });
});
```

This test uses only local data (no real Cloud fetch) for the `'local'`/`'cloud'`-from-already-known-content cases; a `'keep cloud'`/`'keep both'` test additionally needs `fetchRemoteCanonical` to retrieve the conflicting generation's content — write that test using the same `InMemoryRemoteMemoryStore` + `standardCloudBackup` fixture pattern already established in Task 13's tests, pushing a bundle whose canonical content disagrees with local at `notes/a.md`, then calling `resolvePendingConflict(..., 'cloud')` and asserting canonical main now holds Cloud's content; and another asserting `'both'` produces the deterministic `notes/a.conflict-<hash>.md` path from `keepBothPath` (Task 4) for the LOCAL copy while the original path keeps Cloud's.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @stack/cli test -- canonical-ops.test.ts`
Expected: FAIL — the three new functions are not exported yet

- [ ] **Step 4: Implement the conflict-resolution functions**

Append to `packages/cli/src/memory/canonical-ops.ts`:

```ts
import {
  readPendingMerge,
  writePendingMerge as writePendingMergeFile,
  clearPendingMerge,
  readCanonicalMain,
  writeCanonicalMain,
  keepBothPath,
  mergeConflictSchema,
  canonicalMainManifestSchema,
  documentOf,
  type CanonicalDoc,
} from '@stack/memory';
import { z } from 'zod';

const pendingMergeFileSchema = z.object({
  basedOnGeneration: z.number(),
  merged: canonicalMainManifestSchema,
  conflicts: z.array(mergeConflictSchema),
});

export type PendingConflictSummary = { projectId: string; path: string; reason: string };

export const listPendingConflicts = async (stackHome: string): Promise<PendingConflictSummary[]> => {
  const pending = await readPendingMerge(stackHome, pendingMergeFileSchema);
  return pending?.conflicts ?? [];
};

const docText = (doc: CanonicalDoc | undefined, bytes: Uint8Array | undefined): string =>
  doc?.state === 'present' && bytes ? Buffer.from(bytes).toString('utf8') : '';

export const diffPendingConflict = async (
  stackHome: string,
  projectId: string,
  path: string,
  deps: { readObject(contentHash: string): Promise<Uint8Array>; fetchCloud(generation: number): Promise<{ main: import('@stack/memory').CanonicalMainManifest }> },
): Promise<{ local: string; cloud: string }> => {
  const pending = await readPendingMerge(stackHome, pendingMergeFileSchema);
  if (!pending) throw new Error('No pending Memory merge.');
  const local = await readCanonicalMain(stackHome);
  const localDoc = documentOf(local, projectId, path);
  const cloudState = await deps.fetchCloud(pending.basedOnGeneration);
  const cloudDoc = documentOf(cloudState.main, projectId, path);
  return {
    local: docText(localDoc, localDoc?.state === 'present' ? await deps.readObject(localDoc.contentHash) : undefined),
    cloud: docText(cloudDoc, cloudDoc?.state === 'present' ? await deps.readObject(cloudDoc.contentHash) : undefined),
  };
};

/**
 * Resolve one conflicting document. `'local'`/`'cloud'` pick that side's content
 * outright; `'both'` keeps Cloud's content at the original path (already
 * published) and the local content at the deterministic keep-both path (Task 4).
 * Flushes every already-clean document from the pending merge into canonical
 * main as well — not just the one being resolved — and clears the pending merge
 * entirely once no conflicts remain.
 */
export const resolvePendingConflict = async (
  stackHome: string,
  projectId: string,
  path: string,
  keep: 'local' | 'cloud' | 'both',
  deps: { fetchCloud(generation: number): Promise<{ main: import('@stack/memory').CanonicalMainManifest }> },
): Promise<{ resolvedPath: string; altPath?: string }> => {
  const pending = await readPendingMerge(stackHome, pendingMergeFileSchema);
  if (!pending) throw new Error('No pending Memory merge.');
  const conflict = pending.conflicts.find((c) => c.projectId === projectId && c.path === path);
  if (!conflict) throw new Error(`No pending conflict for ${projectId} at ${path}.`);

  const local = await readCanonicalMain(stackHome);
  const localDoc = documentOf(local, projectId, path);
  const cloudState = await deps.fetchCloud(pending.basedOnGeneration);
  const cloudDoc = documentOf(cloudState.main, projectId, path);

  const mergedProjectIndex = pending.merged.projects.findIndex((p) => p.projectId === projectId);
  const mergedDocuments = mergedProjectIndex === -1 ? [] : [...pending.merged.projects[mergedProjectIndex]!.documents];
  let resolvedPath = path;
  let altPath: string | undefined;

  const upsert = (doc: CanonicalDoc) => {
    const i = mergedDocuments.findIndex((d) => d.path === doc.path);
    if (i === -1) mergedDocuments.push(doc); else mergedDocuments[i] = doc;
  };

  if (keep === 'local' && localDoc) upsert(localDoc);
  else if (keep === 'cloud' && cloudDoc) upsert(cloudDoc);
  else if (keep === 'both') {
    if (cloudDoc) upsert(cloudDoc);
    if (localDoc?.state === 'present') {
      altPath = keepBothPath(path, localDoc.contentHash, (candidate) => mergedDocuments.some((d) => d.path === candidate));
      upsert({ ...localDoc, path: altPath });
      resolvedPath = path; // Cloud keeps the original path; see keepBothPath's contract.
    }
  }

  const nextMerged = {
    ...pending.merged,
    projects:
      mergedProjectIndex === -1
        ? [...pending.merged.projects, { projectId, documents: mergedDocuments }]
        : pending.merged.projects.map((p, i) => (i === mergedProjectIndex ? { ...p, documents: mergedDocuments } : p)),
  };
  const nextConflicts = pending.conflicts.filter((c) => !(c.projectId === projectId && c.path === path));

  const mainProjectIndex = local.projects.findIndex((p) => p.projectId === projectId);
  const nextMain = {
    ...local,
    projects:
      mainProjectIndex === -1
        ? [...local.projects, { projectId, documents: mergedDocuments }]
        : local.projects.map((p, i) => (i === mainProjectIndex ? { ...p, documents: mergedDocuments } : p)),
  };
  await writeCanonicalMain(stackHome, nextMain);

  if (nextConflicts.length === 0) await clearPendingMerge(stackHome);
  else await writePendingMergeFile(stackHome, { basedOnGeneration: pending.basedOnGeneration, merged: nextMerged, conflicts: nextConflicts });

  return altPath ? { resolvedPath, altPath } : { resolvedPath };
};

export const materializeProject = async (
  stackHome: string,
  projectId: string,
  claudeHome?: string,
): Promise<{ written: string[]; deleted: string[] }> => {
  const bound = await listBoundProjects(stackHome);
  const record = bound.find((b) => b.projectId === projectId);
  if (!record) throw new Error(`Project ${projectId} is not mapped on this machine.`);
  const registry = await readLocalRegistry(stackHome);
  const scanOptions = {
    ...(claudeHome ? { claudeHome } : {}),
    projects: [{ dir: record.dir }],
    resolveProjectId: (item: DiscoveredMemoryItem) => resolveProjectIdForClaudeItem(item, registry),
  };
  const plan = await planProjectSync(record, stackHome, scanOptions);
  return applyMaterializeActions(record, stackHome, plan.actions, claudeHome);
};
```

`deps.fetchCloud`/`deps.readObject` are injected (rather than hardcoding `fetchRemoteCanonical`/`readMemoryObject` calls) purely so `resolvePendingConflict`/`diffPendingConflict` stay testable without real Cloud/crypto wiring in this file's own unit tests; the CLI command registration in Step 6 wires the real `fetchRemoteCanonical({ ..., generation })` and `readMemoryObject` implementations.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @stack/cli test -- canonical-ops.test.ts`
Expected: PASS

- [ ] **Step 6: Add the three subcommands to `stak memory`**

In `packages/cli/src/commands/memory.ts`, add to `MemoryCommandDependencies`:

```ts
listPendingConflicts?(): Promise<PendingConflictSummary[]>;
resolvePendingConflict?(projectId: string, path: string, keep: 'local' | 'cloud' | 'both'): Promise<{ resolvedPath: string; altPath?: string }>;
diffPendingConflict?(projectId: string, path: string): Promise<{ local: string; cloud: string }>;
materializeProject?(projectId: string): Promise<{ written: string[]; deleted: string[] }>;
materializeAllProjects?(): Promise<void>;
```

and register, following this file's existing `memory.command(...)` style exactly:

```ts
memory
  .command('resolve [project] [path]')
  .description('Resolve a Memory sync conflict: keep local, keep cloud, or keep both')
  .option('--keep <side>', 'local | cloud | both')
  .action(async (project: string | undefined, path: string | undefined, options: { keep?: string }) => {
    if (!dependencies.resolvePendingConflict || !dependencies.listPendingConflicts) throw new Error('Memory conflict resolution is not available.');
    if (!project || !path) {
      const pending = await dependencies.listPendingConflicts();
      dependencies.writeOut(
        pending.length === 0
          ? 'No pending Memory conflicts.\n'
          : pending.map((c) => `${c.projectId}  ${c.path}  (${c.reason})\n`).join(''),
      );
      return;
    }
    if (options.keep !== 'local' && options.keep !== 'cloud' && options.keep !== 'both')
      throw new Error('--keep must be local, cloud, or both.');
    const result = await dependencies.resolvePendingConflict(project, path, options.keep);
    dependencies.writeOut(
      result.altPath
        ? `Resolved: cloud kept at ${result.resolvedPath}, local kept at ${result.altPath}.\n`
        : `Resolved: kept ${options.keep} at ${result.resolvedPath}.\n`,
    );
  });

memory
  .command('diff <project> <path>')
  .description('Show both sides of a pending Memory conflict')
  .action(async (project: string, path: string) => {
    if (!dependencies.diffPendingConflict) throw new Error('Memory diff is not available.');
    const { local, cloud } = await dependencies.diffPendingConflict(project, path);
    dependencies.writeOut(`--- local ---\n${local}\n--- cloud ---\n${cloud}\n`);
  });

memory
  .command('materialize [project]')
  .description('Regenerate agent Memory files from canonical Memory')
  .action(async (project: string | undefined) => {
    if (project) {
      if (!dependencies.materializeProject) throw new Error('Memory materialize is not available.');
      const result = await dependencies.materializeProject(project);
      dependencies.writeOut(`Wrote ${result.written.length}, deleted ${result.deleted.length} file(s) for ${project}.\n`);
      return;
    }
    if (!dependencies.materializeAllProjects) throw new Error('Memory materialize is not available.');
    await dependencies.materializeAllProjects();
    dependencies.writeOut('Materialized Memory for every mapped project.\n');
  });
```

In `packages/cli/src/program.ts`, wire these five dependencies next to the other `memory*` entries, using `buildMemoryCloudDeps()`, `stackHome`, and `claudeHome` exactly as every neighboring entry in that object already does:

```ts
listPendingConflicts: () => listPendingConflicts(stackHome),
resolvePendingConflict: (projectId, path, keep) =>
  resolvePendingConflict(stackHome, projectId, path, keep, {
    fetchCloud: async (generation) => {
      const deps = await buildMemoryCloudDeps();
      const mmk = deps.localKeyStore ? await deps.localKeyStore.loadMmk().catch(() => undefined) : undefined;
      const result = deps.backend
        ? await fetchRemoteCanonical({ backend: deps.backend, ...(mmk ? { mmk } : {}), localRegistry: await readLocalRegistry(stackHome), generation })
        : null;
      return { main: result?.main ?? { schemaVersion: 2 as const, projects: [] } };
    },
  }),
diffPendingConflict: (projectId, path) =>
  diffPendingConflict(stackHome, projectId, path, {
    readObject: (contentHash) => readMemoryObject({ stackHome, contentHash }),
    fetchCloud: async (generation) => {
      const deps = await buildMemoryCloudDeps();
      const mmk = deps.localKeyStore ? await deps.localKeyStore.loadMmk().catch(() => undefined) : undefined;
      const result = deps.backend
        ? await fetchRemoteCanonical({ backend: deps.backend, ...(mmk ? { mmk } : {}), localRegistry: await readLocalRegistry(stackHome), generation })
        : null;
      return { main: result?.main ?? { schemaVersion: 2 as const, projects: [] } };
    },
  }),
materializeProject: (projectId) => materializeProject(stackHome, projectId, claudeHome),
materializeAllProjects: () => materializeAllBoundProjectsForCli(stackHome, claudeHome), // thin wrapper exported from canonical-ops.ts around the same materializeAllBoundProjects used by push/pull
```

Export a small public wrapper `materializeAllBoundProjectsForCli(stackHome: string, claudeHome?: string): Promise<void>` from `canonical-ops.ts` that just calls the existing (module-private) `materializeAllBoundProjects` — needed because that helper was written as a local, non-exported function in Task 13.

- [ ] **Step 7: Run the full CLI test suite**

Run: `pnpm --filter @stack/cli test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/memory/src/canonical/fetch-remote-canonical.ts packages/cli/src/memory/canonical-ops.ts packages/cli/src/memory/canonical-ops.test.ts packages/cli/src/commands/memory.ts packages/cli/src/program.ts
git commit -m "feat(cli): add stak memory resolve/diff/materialize"
```

---

### Task 15: Update `docs/memory.md`

**Files:**
- Modify: `docs/memory.md`

**Steps:**

- [ ] **Step 1: Add a "Canonical Project Memory" section**

Insert a new section after the existing "Logical projects and Project IDs" section (search for that heading), written in the same plain, user-facing style as the rest of this file (short paragraphs, no code blocks except where the file already uses them for commands). Cover, in order:

1. STAK now owns Project Memory itself, in three namespaces (`notes/`, `instructions/`, `agents/<agent>/`), keyed by Project ID — not by Claude's folder layout. Claude is a two-way adapter: it still writes its own files during sessions; `stak add .` imports edits, `stak pull`/`stak push` write changes back out.
2. `stak status` now also reports pending Memory sync actions and conflicts per project.
3. Conflicts: `stak memory resolve`, `stak memory diff`, `stak memory materialize`, each one sentence, matching the command descriptions registered in Task 14.
4. The one-time, automatic local upgrade from the old per-Claude-folder storage: nothing to do, nothing lost, a pre-upgrade backup is kept at `memory/manifests/current.v1-premigration.json`.
5. A short "Not yet available" addition to the file's existing such list: Cursor/Codex adapters, a User (global) Memory scope, rename detection.

- [ ] **Step 2: Update the "What STAK Memory V0 preserves" table's framing**

The existing table (search for `Only these allowlisted, durable surfaces are captured`) still lists the right five Claude-native surfaces, but the three project-scoped rows (`auto-memory` project, `agent-memory` project, `project-private-instructions`) now flow through canonical Memory rather than the old per-Claude-folder manifest — add one sentence above the table noting this, without removing or restructuring the table itself (the underlying surfaces STAK reads from are unchanged; only where their content ends up changed).

- [ ] **Step 3: Commit**

```bash
git add docs/memory.md
git commit -m "docs(memory): document STAK-native canonical Project Memory"
```

---

## Plan self-review

**Spec coverage:** §4.1–4.2 (documents, identity) → Task 1. §4.3 (working copy) → Tasks 5, 10, 12. §4.4–4.5 (adapters, Claude mapping, moved projects, unavailable projects) → Tasks 5, 10. §6 (N/P/C table, safety invariants, mass-delete guard) → Tasks 3, 10. §7 (tombstones, resurrection guard) → Tasks 1, 3. §8.1–8.3 (versioning, push, conflicts, keep-both, resolution tied to generation) → Tasks 4, 7, 9, 13, 14. §8.4 (pull) → Tasks 9A, 13. §8.5 (recover) → unchanged existing `stak memory recover` already rebuilds local state from a chosen generation (Task 7's bundle changes keep that working; no new task needed since recovery's "treat it as a local rollback, push forward" behavior falls out of `pushCanonicalMemory`'s ordinary merge path once the recovered generation becomes the new local base-mismatched state — call this out explicitly to the implementer: after Task 7+13 land, manually verify `stak memory recover --generation N` followed by `stak push` behaves as spec section 8.5 describes, and file a short follow-up task if it does not, rather than silently assuming). §9.1 (migration, resumability, duplicates) → Tasks 6, 7. §9.2 (old-bundle determinism) → Task 7. §9.3 (old-CLI rejection, `@beta` message, deprecated alias) → Tasks 8, 13. §9.4 (server/web counts) → Task 8. §10 (crash safety, errors, privacy) → woven through Tasks 2, 6, 9, 9A (atomic writes, resumable steps, typed errors). §11 (testing) → a unit test accompanies every task; the two-machine Cloud scenarios are called out explicitly in Tasks 13/14's test steps. §12 (done-when) → satisfied by Tasks 1 (Project-ID-keyed identity), 10 (materialize/regenerate), 6 (automatic upgrade), 8 (old-CLI rejection).

**Placeholder scan:** every code step above contains real, complete code. The two spots that lean on "copy this existing file's pattern" (Task 11 Step 1's test sketch, Task 13 Step 3's test sketch) point at a specific existing test file to copy from rather than describing what to do abstractly — flagged here rather than left silent: an implementer must read `packages/memory/src/remote/modes.test.ts` and `packages/cli/src/memory/cloud-ops.test.ts` respectively before writing those two test bodies.

**Type consistency check:** `CanonicalDoc`/`CanonicalMainManifest` (Task 1) are used with the same shape throughout Tasks 2–14. `SyncAction` (Task 3) is consumed unchanged by Task 10. `MergeConflict`/`mergeConflictSchema` (Task 4) flow through `push.ts` (Task 9), the pending-merge file (Task 2/9), and `canonical-ops.ts`'s conflict-resolution functions (Task 14) with the same field names (`projectId`, `path`, `reason`). `BoundProject` (Task 5) is the same `{ projectId, dir }` shape used by `project-sync.ts` (Task 10) and every CLI call site (Tasks 12–14). `PushDeps`/`PullDeps` (Tasks 9, 9A) are each used with matching field names at their one real call site (Task 13).

**One known gap, called out rather than silently resolved:** Task 13 Step 1's `publishCanonicalGeneration` does not independently verify `expectedParent` before calling `standardCloudBackup`/`protectedCloudBackup` (those functions compute their own `expectedParent` from a fresh `getLatest()` call). In the narrow window between `pushCanonicalMemory`'s own `fetchRemote()` and the moment `publish` actually calls `createGeneration`, Cloud could in principle move twice in quick succession in a way that makes this inexact. This is the same race window `pushCanonicalMemory`'s retry loop (Task 9) already exists to cover — `createGeneration`'s own `expectedParent` check (unchanged, existing code) is what actually enforces correctness; the retry loop is what makes a detected race transparent to the user instead of a hard failure. No action needed, but an implementer should not "fix" this by adding a second expectedParent check in `publishCanonicalGeneration` — that would be redundant with `createGeneration`'s own check, not a correctness improvement.

