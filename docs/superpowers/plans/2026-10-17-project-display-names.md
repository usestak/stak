# Logical Project Display Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a STAK logical Project's human-readable name (`displayName`) derivable at Memory-backup/discovery time — not only from an explicit `stak project map` binding — so a recovered-but-unmapped Project (e.g. on a second machine) renders as `nexus` / `4 memory files` / `not mapped on this machine`, never `prj_m62c51… local project` / `recovered from: local:C--Users-...` / `not available on this machine`.

**Architecture:** `discoverClaudeMemory` already resolves each native project's real directory (via a passed candidate, or via `reconstructProjectDir`) purely to check Git identity, then discards it. We capture that resolved directory's safe basename through a new optional callback, persist it as a **machine-local-only name hint** (`projectId -> basename`) inside the existing local project registry file (never in the portable snapshot that travels in a Memory bundle, never a full path), and feed it into the already-existing Cloud `name` sync path and CLI rendering as a new precedence tier between "Git canonical" and "basename from an explicit mapping". No `projectId`/identity logic changes, no SQL migration (the nullable `cloud_projects.name` column already exists from `0005_product_read_models.sql`), no changes to `recoveryReference` (confirmed never uploaded today). One real bug found during the audit — the Supabase `syncProjects` upsert writes `name: project.name ?? null`, which would **erase** a Cloud name the instant any machine syncs a row without a name (exactly what Machine B does on `stak memory recover` before mapping) — is fixed by preserving the existing name when the incoming payload omits one.

**Tech Stack:** TypeScript, Zod, Vitest, pnpm/turbo monorepo (`@stack/memory`, `@stack/cli`, `apps/web` against Supabase).

## Global Constraints

- Do NOT modify `projectId` generation, matching, reconciliation, or restore identity. Restore/association stays keyed by `projectId` + mapping only, never by name.
- Do NOT add a SQL migration. Use the existing nullable `cloud_projects.name` column.
- Do NOT put any absolute path, or anything derived from a full path beyond a safe basename, into: the portable registry snapshot, the Memory bundle, a Cloud API payload, or `recoveryReference`.
- Do NOT redesign `recoveryReference` or touch Realtime/synchronization code.
- Do NOT push, publish npm, or tag. One commit only, on top of `bccbe76`.
- Naming precedence (spec §6), most to least preferred: (1) an existing explicit logical name — no such feature exists yet, so this tier is a no-op today and must not be invented; (2) Git-repo-derived canonical name; (3) safe basename captured at Memory-backup discovery time (new, this plan); (4) safe basename from an explicit `stak project map` binding (existing); (5) legacy fallback `Local project · <id>` (existing, unchanged).
- A safe basename is `path.basename(dir)`, rejected if empty, `.`, `..`, or containing a path separator, and capped at 200 chars — this exact rule already exists as `localProjectDisplayName` in `packages/cli/src/cloud/checkin.ts`; it moves into `@stack/memory` as `safeDirectoryBasename` so both the discovery hook and the Cloud-sync path share one implementation.

---

### Task 1: Shared safe-basename helper in `@stack/memory`

**Files:**

- Modify: `packages/memory/src/project-identity.ts`
- Test: `packages/memory/src/project-identity.test.ts`

**Interfaces:**

- Produces: `safeDirectoryBasename(dir: string | null | undefined): string | undefined` — used by Task 2 (discovery hook) and Task 6 (Cloud sync payload, replacing the cli-local copy).

- [ ] **Step 1: Write the failing test**

Add to `packages/memory/src/project-identity.test.ts` (create the file if it does not exist, following the existing `describe`/`it` style used in `git-identity-continuity.test.ts`):

```ts
import { describe, expect, it } from 'vitest';

import { safeDirectoryBasename } from './project-identity.js';

describe('safeDirectoryBasename', () => {
  it('returns the final path segment only', () => {
    expect(safeDirectoryBasename('C:/Users/NT/Desktop/nexus')).toBe('nexus');
    expect(safeDirectoryBasename('/Users/dana/work/nexus')).toBe('nexus');
  });

  it('returns undefined for null/undefined input', () => {
    expect(safeDirectoryBasename(null)).toBeUndefined();
    expect(safeDirectoryBasename(undefined)).toBeUndefined();
  });

  it('returns undefined for a root/degenerate path with no safe basename', () => {
    expect(safeDirectoryBasename('C:\\')).toBeUndefined();
    expect(safeDirectoryBasename('/')).toBeUndefined();
  });

  it('never returns a string containing a path separator', () => {
    expect(safeDirectoryBasename('C:/Users/NT/Desktop/nexus')).not.toMatch(
      /[\\/]/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (PowerShell, from repo root): `pnpm --filter @stack/memory test -- project-identity.test.ts`
Expected: FAIL — `safeDirectoryBasename` is not exported from `./project-identity.js`.

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/project-identity.ts`, add (near the other pure helpers, after `projectIdentityMatches`):

```ts
/**
 * A Cloud-safe, UI-safe display basename for a local directory (e.g. `nexus` from
 * `C:\Users\NT\Desktop\nexus`), never the path itself. `path.basename` cannot return a
 * string containing a path separator, so this can never smuggle directory structure.
 * Returns `undefined` when no safe basename can be determined (root/degenerate path).
 */
export const safeDirectoryBasename = (
  dir: string | null | undefined,
): string | undefined => {
  if (!dir) return undefined;
  const base = path.basename(dir).trim();
  if (!base || base === '.' || base === '..') return undefined;
  if (/[\\/]/.test(base)) return undefined;
  return base.slice(0, 200);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/memory test -- project-identity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

Do not commit yet — one commit covers the whole plan (Task 10).

---

### Task 2: Capture the resolved directory during native discovery

**Files:**

- Modify: `packages/memory/src/claude-adapter.ts`
- Test: `packages/memory/src/git-identity-continuity.test.ts`

**Interfaces:**

- Consumes: `safeDirectoryBasename` is NOT used here (the hook passes the raw resolved `dir`; sanitizing happens where the hint is captured, Task 4).
- Produces: `ClaudeMemoryDiscoveryOptions.onLocalProjectResolved?: (vendorKey: string, dir: string) => void` — called by Task 4's `backup()` wiring.

- [ ] **Step 1: Write the failing test**

Add to `packages/memory/src/git-identity-continuity.test.ts`, inside (or right after) the existing `describe('Git identity continuity across restored native memory (15B.4)', ...)` block, reusing its `seedNativeClaude` helper but with a remote-less variant so the identity stays `local`:

```ts
describe('onLocalProjectResolved hook (discovery-time basename capture)', () => {
  it('fires with the vendor key and the real resolved directory for an unmatched local project with no Git remote', async () => {
    const claudeHome = await tempDir('claude-');
    const checkout = path.join(await tempDir('repos-'), 'nexus');
    await mkdir(checkout, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(checkout);
    const memoryDir = path.join(claudeHome, 'projects', vendorKey, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, 'n1.md'), '# nexus\n', 'utf8');

    const resolved: Array<{ vendorKey: string; dir: string }> = [];
    const items = await discoverClaudeMemory({
      claudeHome,
      gitRemoteOf: async () => undefined, // no remote → identity stays local
      isDirectory,
      platform: process.platform,
      onLocalProjectResolved: (key, dir) =>
        resolved.push({ vendorKey: key, dir }),
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.project).toEqual({ kind: 'local', vendorKey });
    expect(resolved).toEqual([{ vendorKey, dir: path.resolve(checkout) }]);
  });

  it('never fires for a project that resolved to a Git identity', async () => {
    const claudeHome = await tempDir('claude-');
    const checkout = path.join(await tempDir('repos-'), 'atlas-access-flow');
    await mkdir(checkout, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(checkout);
    const memoryDir = path.join(claudeHome, 'projects', vendorKey, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, 'a1.md'), '# atlas\n', 'utf8');

    const resolved: Array<{ vendorKey: string; dir: string }> = [];
    await discoverClaudeMemory({
      claudeHome,
      gitRemoteOf: async (dir) =>
        path.resolve(dir) === path.resolve(checkout)
          ? 'https://github.com/example/atlas.git'
          : undefined,
      isDirectory,
      platform: process.platform,
      onLocalProjectResolved: (key, dir) =>
        resolved.push({ vendorKey: key, dir }),
    });

    expect(resolved).toEqual([]);
  });
});
```

(`tempDir`, `isDirectory`, `encodeClaudeProjectKey`, `discoverClaudeMemory`, `mkdir`, `writeFile`, `path` are already imported at the top of this test file — reuse them, do not re-import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/memory test -- git-identity-continuity.test.ts`
Expected: FAIL (TS error or runtime: `onLocalProjectResolved` does not exist on `ClaudeMemoryDiscoveryOptions` / is never called).

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/claude-adapter.ts`:

1. Extend the options type (after `isDirectory?:` at line 41):

```ts
  isDirectory?: (candidate: string) => Promise<boolean>;
  /**
   * Fired, best-effort, whenever step 3 resolves a real on-disk directory for a vendor
   * key that remains a LOCAL identity (no Git remote) — whether resolved via a passed
   * candidate or via `reconstructProjectDir`. The directory is the raw resolved value
   * (never sanitized here); callers decide what, if anything, to persist from it. Never
   * fired for a vendor key that resolves to a Git identity (it already has a portable
   * name) or for one that never resolves to a real directory at all.
   */
  onLocalProjectResolved?: (vendorKey: string, dir: string) => void;
```

2. In step 3 (the `for (const vendorKey of await listDirNames(projectsRoot))` loop), track the candidate directory alongside the existing `gitByVendorKey` map, and fire the hook once `identity` is finalized:

Replace:

```ts
const gitByVendorKey = new Map<string, ProjectIdentity>();
for (const project of options.projects ?? []) {
  const git = canonicalGitIdentity(project.gitRemote);
  if (!git) continue; // no origin → do not resolve; leave as local
  gitByVendorKey.set(
    normalizeVendorKey(encodeClaudeProjectKey(project.dir), platform),
    git,
  );
}
```

with:

```ts
const gitByVendorKey = new Map<string, ProjectIdentity>();
const dirByVendorKey = new Map<string, string>();
for (const project of options.projects ?? []) {
  const key = normalizeVendorKey(encodeClaudeProjectKey(project.dir), platform);
  dirByVendorKey.set(key, path.resolve(project.dir));
  const git = canonicalGitIdentity(project.gitRemote);
  if (!git) continue; // no origin → do not resolve; leave as local
  gitByVendorKey.set(key, git);
}
```

Then replace the body of the `for (const vendorKey of await listDirNames(projectsRoot))` loop's identity-resolution block:

```ts
let identity =
  gitByVendorKey.get(normalizeVendorKey(vendorKey, platform)) ?? null;
if (!identity && options.gitRemoteOf && options.isDirectory) {
  const dir = await reconstructProjectDir({
    vendorKey,
    isDirectory: options.isDirectory,
    platform,
  });
  if (dir) {
    const git = canonicalGitIdentity(await options.gitRemoteOf(dir));
    if (git) identity = git;
  }
}
identity = identity ?? localIdentity(vendorKey);
```

with:

```ts
const normalizedKey = normalizeVendorKey(vendorKey, platform);
let identity = gitByVendorKey.get(normalizedKey) ?? null;
let resolvedDir = dirByVendorKey.get(normalizedKey);
if (!identity && options.gitRemoteOf && options.isDirectory) {
  const dir = await reconstructProjectDir({
    vendorKey,
    isDirectory: options.isDirectory,
    platform,
  });
  if (dir) {
    resolvedDir = dir;
    const git = canonicalGitIdentity(await options.gitRemoteOf(dir));
    if (git) identity = git;
  }
}
identity = identity ?? localIdentity(vendorKey);
if (resolvedDir && identity.kind === 'local')
  options.onLocalProjectResolved?.(vendorKey, resolvedDir);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/memory test -- git-identity-continuity.test.ts`
Expected: PASS, and no existing test in this file or `claude-adapter.test.ts` regresses (the hook is optional and additive).

Then run the full package once to catch any other caller: `pnpm --filter @stack/memory test`

- [ ] **Step 5: Commit**

Not yet — single commit at the end (Task 10).

---

### Task 3: Machine-local name hints on the local project registry

**Files:**

- Modify: `packages/memory/src/project/registry.ts`
- Test: `packages/memory/src/project/registry.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `LocalRegistry.nameHints?: ProjectNameHint[]`, `setNameHint(registry, projectId, name): LocalRegistry`, `nameHintFor(registry, projectId): string | undefined`, type `ProjectNameHint = { projectId: string; name: string }`. Used by Task 4 (`registry-store.ts`) and Task 5 (`project-ops.ts`).

- [ ] **Step 1: Write the failing test**

Add to `packages/memory/src/project/registry.test.ts` (if the file doesn't exist yet, check first — if it does, append; follow its existing import/style):

```ts
import { describe, expect, it } from 'vitest';

import {
  emptyRegistry,
  nameHintFor,
  setNameHint,
  type LocalRegistry,
} from './registry.js';

describe('name hints (machine-local, never portable)', () => {
  it('setNameHint adds a hint retrievable by nameHintFor', () => {
    const registry = setNameHint(emptyRegistry(), 'prj_abc123', 'nexus');
    expect(nameHintFor(registry, 'prj_abc123')).toBe('nexus');
  });

  it('nameHintFor returns undefined when no hint exists', () => {
    expect(nameHintFor(emptyRegistry(), 'prj_abc123')).toBeUndefined();
  });

  it('setNameHint replaces an existing hint for the same projectId rather than duplicating', () => {
    let registry = setNameHint(emptyRegistry(), 'prj_abc123', 'old-name');
    registry = setNameHint(registry, 'prj_abc123', 'new-name');
    expect(nameHintFor(registry, 'prj_abc123')).toBe('new-name');
    expect(registry.nameHints).toHaveLength(1);
  });

  it('is absent from a fresh empty registry', () => {
    expect(emptyRegistry().nameHints).toEqual([]);
  });

  it('never mutates the input registry', () => {
    const before: LocalRegistry = emptyRegistry();
    const snapshot = JSON.parse(JSON.stringify(before));
    setNameHint(before, 'prj_abc123', 'nexus');
    expect(before).toEqual(snapshot);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/memory test -- registry.test.ts`
Expected: FAIL — `nameHintFor`/`setNameHint` not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/project/registry.ts`:

1. After `machineBindingSchema`/`MachineBinding` (around line 84), add:

```ts
/**
 * A machine-local, advisory display-name hint for a Project ID — the safe basename
 * captured the last time Memory backup discovered this project's directory on THIS
 * machine (see `claude-adapter.ts`'s `onLocalProjectResolved`). It is NEVER part of
 * the portable snapshot and NEVER a full path; it exists only so the Cloud `name` sync
 * and `stak project` CLI rendering can show a recognizable name even when the project
 * is not currently bound (`stak project map`) on this machine.
 */
export const projectNameHintSchema = z.object({
  projectId: z.string().regex(PROJECT_ID_PATTERN),
  name: z.string().min(1).max(200),
});
export type ProjectNameHint = z.infer<typeof projectNameHintSchema>;
```

2. Update `localRegistrySchema` (line 87-92):

```ts
export const localRegistrySchema = z.object({
  schemaVersion: z.literal(LOCAL_REGISTRY_VERSION),
  projects: z.array(portableProjectRecordSchema),
  bindings: z.array(machineBindingSchema),
  // Optional so pre-existing registry files decode safely; absence means no hints yet.
  nameHints: z.array(projectNameHintSchema).optional(),
});
export type LocalRegistry = z.infer<typeof localRegistrySchema>;
```

3. Update `emptyRegistry` (line 94-98):

```ts
export const emptyRegistry = (): LocalRegistry => ({
  schemaVersion: LOCAL_REGISTRY_VERSION,
  projects: [],
  bindings: [],
  nameHints: [],
});
```

4. After the `bindings` section's `setBinding` function (after line 340, before `registryConflicts`), add:

```ts
/** A registry's name hints, defaulting a pre-existing (field-absent) registry to none. */
export const nameHintsOf = (registry: LocalRegistry): ProjectNameHint[] =>
  registry.nameHints ?? [];

export const nameHintFor = (
  registry: LocalRegistry,
  projectId: string,
): string | undefined =>
  nameHintsOf(registry).find((hint) => hint.projectId === projectId)?.name;

/** Set (or replace) a Project's discovery-time name hint. Never mutates the input. */
export const setNameHint = (
  registry: LocalRegistry,
  projectId: string,
  name: string,
): LocalRegistry => ({
  ...registry,
  nameHints: [
    ...nameHintsOf(registry).filter((hint) => hint.projectId !== projectId),
    { projectId, name },
  ],
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/memory test -- registry.test.ts`
Expected: PASS. Then run `pnpm --filter @stack/memory test` to confirm `toPortableSnapshot` and existing registry tests are unaffected (the new field is excluded from the portable snapshot by construction — `toPortableSnapshot` only reads `registry.projects`, never `registry.nameHints`).

- [ ] **Step 5: Commit**

Not yet.

---

### Task 4: Wire the discovery hint into backup-time registry sync

**Files:**

- Modify: `packages/memory/src/project/registry-store.ts`
- Modify: `packages/memory/src/adapter.ts`
- Test: `packages/memory/src/project/registry-store.test.ts`

**Interfaces:**

- Consumes: `setNameHint` from Task 3; `safeDirectoryBasename` from Task 1; `onLocalProjectResolved` from Task 2.
- Produces: `syncRegistryForBackup` gains an optional `nameHints?: Map<string, string>` parameter (vendorKey → safe basename). `createClaudeMemoryAdapter(...).backup()` now persists a name hint for every local project it discovers a directory for this run.

- [ ] **Step 1: Write the failing test**

Add to `packages/memory/src/project/registry-store.test.ts`, reusing its existing `tempHome`, `localItem`, `writeManifest` helpers:

```ts
describe('syncRegistryForBackup name hints', () => {
  it('persists a discovery-time name hint for a local project, keyed by its resolved Project ID', async () => {
    const stackHome = await tempHome();
    await writeManifest(stackHome, [
      localItem('C--Users-NT-Desktop-nexus', 'n1.md'),
    ]);

    const { registry } = await syncRegistryForBackup({
      stackHome,
      nameHints: new Map([['C--Users-NT-Desktop-nexus', 'nexus']]),
    });

    const record = registry.projects[0];
    expect(record).toBeDefined();
    expect(nameHintFor(registry, record!.projectId)).toBe('nexus');

    // Persisted to disk, not just returned in-memory.
    const reloaded = await readLocalRegistry(stackHome);
    expect(nameHintFor(reloaded, record!.projectId)).toBe('nexus');
  });

  it('does not add a hint for a vendor key the manifest does not reference', async () => {
    const stackHome = await tempHome();
    await writeManifest(stackHome, [
      localItem('C--Users-NT-Desktop-nexus', 'n1.md'),
    ]);

    const { registry } = await syncRegistryForBackup({
      stackHome,
      nameHints: new Map([['C--Users-NT-Desktop-swft', 'swft']]), // unrelated vendor key
    });

    const record = registry.projects[0];
    expect(nameHintFor(registry, record!.projectId)).toBeUndefined();
  });

  it('never writes a name hint into the portable snapshot', async () => {
    const stackHome = await tempHome();
    await writeManifest(stackHome, [
      localItem('C--Users-NT-Desktop-nexus', 'n1.md'),
    ]);

    await syncRegistryForBackup({
      stackHome,
      nameHints: new Map([['C--Users-NT-Desktop-nexus', 'nexus']]),
    });

    const snapshot = await readPortableSnapshot(stackHome);
    expect(JSON.stringify(snapshot)).not.toContain('nexus');
  });
});
```

Add the one new import this needs at the top of the file: `import { nameHintFor, setBinding } from './registry.js';` (merge with the existing `setBinding` import line).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/memory test -- registry-store.test.ts`
Expected: FAIL — `syncRegistryForBackup` does not accept/apply `nameHints`.

- [ ] **Step 3: Write minimal implementation**

In `packages/memory/src/project/registry-store.ts`:

1. Add `setNameHint` to the import from `./registry.js`.

2. Replace `syncRegistryForBackup`:

```ts
export const syncRegistryForBackup = async (options: {
  stackHome: string;
  mint?: () => string;
  /** vendorKey -> safe basename, collected by the caller from this run's native discovery
   *  (`onLocalProjectResolved`). Only applied to a LOCAL identity the current manifest
   *  actually references by that vendor key; unrelated keys are ignored. */
  nameHints?: Map<string, string>;
}): Promise<{ registry: LocalRegistry; minted: number }> => {
  let registry = await readLocalRegistry(options.stackHome);
  let minted = 0;
  for (const identity of await manifestProjectIdentities(options.stackHome)) {
    const result = resolveOrMintProject(registry, identity, options.mint);
    registry = result.registry;
    if (result.minted) minted += 1;
    if (identity.kind === 'local' && identity.vendorKey) {
      const hint = options.nameHints?.get(identity.vendorKey);
      if (hint) registry = setNameHint(registry, result.projectId, hint);
    }
  }
  await writeLocalRegistry(options.stackHome, registry);
  await writePortableSnapshot(options.stackHome, toPortableSnapshot(registry));
  return { registry, minted };
};
```

3. In `packages/memory/src/adapter.ts`, add the import and wire `backup()`:

```ts
import { safeDirectoryBasename } from './project-identity.js';
```

Replace the `backup` method body:

```ts
    backup: async () => {
      const nameHints = new Map<string, string>();
      const nativeItems = await discoverClaudeMemory({
        ...discoveryOptions,
        onLocalProjectResolved: (vendorKey, dir) => {
          const base = safeDirectoryBasename(dir);
          if (base) nameHints.set(vendorKey, base);
        },
      });
      // Phase 15B.3: compose the next backup as the native scan PLUS previously
      // backed-up Memory whose project is unavailable on this machine, so a new
      // generation never silently drops unresolved Memory.
      const composition = await planMemoryBackupComposition({
        stackHome: options.stackHome,
        nativeItems,
        registry: await readLocalRegistry(options.stackHome),
        ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
        ...(options.projects ? { projects: options.projects } : {}),
      });
      const result = await runMemoryBackup({
        stackHome: options.stackHome,
        items: nativeItems,
        carryForward: composition.carriedForward,
        ...(options.now ? { now: options.now } : {}),
      });
      // Phase 15B: resolve/mint stable Project IDs and refresh the portable
      // registry snapshot the next Cloud bundle will carry (paths never included).
      // Also persists this run's discovery-time name hints (machine-local only).
      await syncRegistryForBackup({ stackHome: options.stackHome, nameHints });
      return result;
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/memory test -- registry-store.test.ts`
Expected: PASS. Then: `pnpm --filter @stack/memory test` (full package) and `pnpm --filter @stack/memory build` to confirm no type errors ripple into `adapter.ts`'s callers.

- [ ] **Step 5: Commit**

Not yet.

---

### Task 5: Surface the name hint through `stak project` (CLI)

**Files:**

- Modify: `packages/cli/src/memory/project-ops.ts`
- Test: `packages/cli/src/memory/project-ops.test.ts`

**Interfaces:**

- Consumes: `nameHintFor` from `@stack/memory` (Task 3).
- Produces: `ProjectListRow.discoveredName: string | null` — consumed by Task 6 (`checkin.ts`) and Task 7 (`project.ts`).

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/src/memory/project-ops.test.ts`, near the existing `listProjects` tests (follow the file's existing setup pattern — check how `stackHome`/registry files are seeded in the surrounding tests, e.g. around line 95-140, and mirror it):

```ts
describe('discoveredName (project-naming UX, recovery path)', () => {
  it('surfaces a persisted discovery-time name hint even when the project is unmapped', async () => {
    const stackHome = await tempHome(); // reuse this file's existing temp-home helper
    await writeManifest(stackHome, [
      localItem('C--Users-NT-Desktop-nexus', 'n1.md'),
    ]);
    await syncRegistryForBackup({
      stackHome,
      nameHints: new Map([['C--Users-NT-Desktop-nexus', 'nexus']]),
    });

    const rows = await listProjects({ stackHome });
    expect(rows[0]?.discoveredName).toBe('nexus');
    expect(rows[0]?.binding).toBeNull();
    expect(rows[0]?.availability).toBe('unavailable');
  });

  it('is null when no hint was ever captured', async () => {
    const stackHome = await tempHome();
    await writeManifest(stackHome, [
      localItem('C--Users-NT-Desktop-nexus', 'n1.md'),
    ]);
    await syncRegistryForBackup({ stackHome });

    const rows = await listProjects({ stackHome });
    expect(rows[0]?.discoveredName).toBeNull();
  });
});
```

Add `syncRegistryForBackup` to this test file's existing `@stack/memory` import if not already imported, and confirm/reuse whatever helper this file already uses to seed a manifest (named `writeManifest`/`localItem` or similar — check the file's existing top-of-file helpers before adding duplicates).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/cli test -- project-ops.test.ts`
Expected: FAIL — `ProjectListRow` has no `discoveredName` property.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/memory/project-ops.ts`:

1. Add `nameHintFor` to the `@stack/memory` import block.

2. Add the field to `ProjectListRow` (after `recoveryReference`):

```ts
export type ProjectListRow = {
  projectId: string;
  identity: ProjectIdentityView;
  lifecycle: 'active' | 'archived';
  binding: string | null;
  files: number;
  availability: 'present' | 'unavailable';
  conflict: boolean;
  recoveryReference: RecoveryReference | null;
  // Machine-local discovery-time basename hint (never a full path) — see
  // `@stack/memory`'s `nameHintFor`. Null when no hint has ever been captured on this
  // machine. Takes precedence over the binding's basename (see `checkin.ts`'s
  // `projectSyncPayloadFrom` and `project.ts`'s `identityLabel`).
  discoveredName: string | null;
};
```

3. In `listProjects`'s `.map((record) => { ... })` body, add the field to the returned object (after `recoveryReference`):

```ts
        discoveredName: nameHintFor(registry, record.projectId) ?? null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/cli test -- project-ops.test.ts`
Expected: PASS. Then `pnpm --filter @stack/cli build` — this will surface every other place `ProjectListRow` is constructed/consumed (Tasks 6 and 7) as type errors; that's expected and fixed by those tasks.

- [ ] **Step 5: Commit**

Not yet.

---

### Task 6: Cloud sync precedence — discovery hint before binding basename

**Files:**

- Modify: `packages/cli/src/cloud/checkin.ts`
- Test: `packages/cli/src/cloud/checkin.test.ts`

**Interfaces:**

- Consumes: `safeDirectoryBasename` from `@stack/memory` (Task 1); `discoveredName` field from `ProjectListRow` (Task 5, consumed structurally via `ProjectSyncRowLike`).
- Produces: `ProjectSyncRowLike` gains `discoveredName?: string | null`; `projectSyncPayloadFrom` precedence becomes git canonical > `discoveredName` > binding basename > no name.

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/src/cloud/checkin.test.ts`, inside the existing `describe('projectSyncPayloadFrom ...)` block (after its current three tests):

```ts
it('prefers the discovery-time name hint over the binding basename when both are present', () => {
  const payload = projectSyncPayloadFrom([
    {
      projectId: 'prj_local',
      identity: { kind: 'local' },
      binding: 'C:/Users/NT/Desktop/old-folder-name',
      discoveredName: 'nexus',
    },
  ]);
  expect(payload).toEqual([{ projectId: 'prj_local', name: 'nexus' }]);
});

it('falls back to the binding basename when there is no discovery-time name hint', () => {
  const payload = projectSyncPayloadFrom([
    {
      projectId: 'prj_local',
      identity: { kind: 'local' },
      binding: 'C:/Users/NT/Desktop/swft',
      discoveredName: null,
    },
  ]);
  expect(payload).toEqual([{ projectId: 'prj_local', name: 'swft' }]);
});

it('names an unmapped Local project from its discovery-time hint alone (the recovery case)', () => {
  const payload = projectSyncPayloadFrom([
    {
      projectId: 'prj_local',
      identity: { kind: 'local' },
      binding: null,
      discoveredName: 'nexus',
    },
  ]);
  expect(payload).toEqual([{ projectId: 'prj_local', name: 'nexus' }]);
});
```

(Leave the existing three tests in that `describe` block untouched — they must still pass unmodified, since `discoveredName` is optional.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/cli test -- checkin.test.ts`
Expected: FAIL — `discoveredName` not recognized / precedence not implemented (TS may also flag the new field if `ProjectSyncRowLike` isn't updated yet, which is fine — fix in Step 3).

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/cloud/checkin.ts`:

1. Add the import: `import { safeDirectoryBasename } from '@stack/memory';`

2. Replace `localProjectDisplayName`'s body to delegate (keep the exported name and doc comment — only the body changes, removing the now-duplicated `path` import if nothing else in the file uses `path`; check first):

```ts
export const localProjectDisplayName = (
  dir: string | null | undefined,
): string | undefined => safeDirectoryBasename(dir);
```

Check whether `import path from 'node:path';` at the top of `checkin.ts` is still used elsewhere in the file; if not, remove it (keep the file lint-clean).

3. Extend `ProjectSyncRowLike`:

```ts
export type ProjectSyncRowLike = {
  projectId: string;
  identity:
    { kind: 'git'; canonical: string } | { kind: 'local'; vendorKey?: string };
  binding?: string | null;
  // Machine-local discovery-time basename hint (see `@stack/memory`'s `nameHintFor`),
  // never a full path. Takes precedence over `binding`'s basename — a project's
  // discovery-time name should not flip just because its current mapping points
  // somewhere with a different folder name.
  discoveredName?: string | null;
};
```

4. Replace `projectSyncPayloadFrom`:

```ts
export const projectSyncPayloadFrom = (
  rows: ProjectSyncRowLike[],
): { projectId: string; name?: string }[] =>
  rows.map((row) => {
    if (row.identity.kind === 'git')
      return { projectId: row.projectId, name: row.identity.canonical };
    const name = row.discoveredName || localProjectDisplayName(row.binding);
    return name
      ? { projectId: row.projectId, name }
      : { projectId: row.projectId };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/cli test -- checkin.test.ts`
Expected: PASS (all tests in both `describe` blocks, old and new).

- [ ] **Step 5: Commit**

Not yet.

---

### Task 7: CLI `stak project` rendering prefers the discovery-time name

**Files:**

- Modify: `packages/cli/src/commands/project.ts`
- Test: `packages/cli/src/commands/project.test.ts`

**Interfaces:**

- Consumes: `ProjectListRow.discoveredName` (Task 5).

- [ ] **Step 1: Write the failing test**

In `packages/cli/src/commands/project.test.ts`, update `baseRow` to include the new required field, and add a test:

```ts
const baseRow = (overrides: Partial<ProjectListRow>): ProjectListRow => ({
  projectId: 'prj_abc123',
  identity: { kind: 'local' },
  lifecycle: 'active',
  binding: null,
  files: 0,
  availability: 'unavailable',
  conflict: false,
  recoveryReference: null,
  discoveredName: null,
  ...overrides,
});
```

Add, inside the existing `describe('identityLabel (project-naming UX)', ...)` block:

```ts
it('shows the discovery-time name hint for an unmapped Local project, never the generic label', () => {
  const row = baseRow({ binding: null, discoveredName: 'nexus' });
  expect(identityLabel(row)).toBe('nexus');
});

it('prefers the discovery-time name hint over the binding basename when both are present', () => {
  const row = baseRow({
    binding: 'C:/Users/NT/Desktop/old-folder-name',
    discoveredName: 'nexus',
  });
  expect(identityLabel(row)).toBe('nexus');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/cli test -- project.test.ts`
Expected: FAIL — `identityLabel` ignores `discoveredName`, still returns `'local project'` / the binding basename.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/commands/project.ts`, replace `identityLabel`:

```ts
export const identityLabel = (row: ProjectListRow): string => {
  if (row.identity.kind === 'git') return row.identity.canonical;
  if (row.discoveredName) return row.discoveredName;
  if (!row.binding) return 'local project';
  const base = path.basename(row.binding).trim();
  return base && base !== '.' && base !== '..' ? base : 'local project';
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/cli test -- project.test.ts`
Expected: PASS (all existing + 2 new tests). Then `pnpm --filter @stack/cli test` (full package) and `pnpm --filter @stack/cli build` to confirm nothing else constructs a `ProjectListRow` literal that is now missing `discoveredName` (grep first: `grep -rn "recoveryReference:" packages/cli/src --include=*.ts` to catch any other literal before running).

- [ ] **Step 5: Commit**

Not yet.

---

### Task 8: Fix Cloud name erasure on a nameless sync (recovery-path regression)

**Files:**

- Modify: `apps/web/lib/repository.ts`
- Test: `apps/web/lib/repository.test.ts` (new file)

**Interfaces:**

- Produces: `resolveSyncedProjectName(incoming: string | undefined, existing: string | null): string | null` — a pure helper, exported for the unit test; wired into `supabaseRepository().syncProjects`.

**Why this is in scope:** once Task 6 ships, Machine B's `stak memory recover` (before any `stak project map`) sends a sync row with no `name` for a project Machine A already named in Cloud (the recovered registry carries no binding and no machine-local name hint — hints are never portable, by design). The current upsert (`name: project.name ?? null`) would null that Cloud name out. This directly breaks the Recovery Flow the spec requires (§2, §11): a Project's Cloud-known name must survive being seen, nameless, by a machine that doesn't currently know it.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/repository.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { resolveSyncedProjectName } from './repository.js';

describe('resolveSyncedProjectName (Cloud project-name sync, recovery-path safety)', () => {
  it('an incoming name always wins (fresher discovery)', () => {
    expect(resolveSyncedProjectName('nexus', 'old-name')).toBe('nexus');
    expect(resolveSyncedProjectName('nexus', null)).toBe('nexus');
  });

  it('preserves the existing Cloud name when the incoming sync carries no name', () => {
    expect(resolveSyncedProjectName(undefined, 'nexus')).toBe('nexus');
  });

  it('stays null when neither the incoming sync nor the existing row has a name', () => {
    expect(resolveSyncedProjectName(undefined, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- repository.test.ts`
Expected: FAIL — `resolveSyncedProjectName` is not exported from `./repository.ts`.

- [ ] **Step 3: Write minimal implementation**

In `apps/web/lib/repository.ts`:

1. Add, near the top-level helpers (above `supabaseRepository`):

```ts
/**
 * Resolve the `name` to persist on a Project-sync upsert row. An incoming name always
 * wins (it reflects this sync's fresher discovery — a Git canonical or a safe basename).
 * When the incoming payload carries no name at all (nothing safely derivable on the
 * syncing machine this run — e.g. an unmapped Local project recovered on a second
 * machine, before it has been mapped there), the EXISTING Cloud name is preserved
 * rather than erased: a sync from a machine that currently knows less about a Project
 * must never un-name it for every other machine (spec §6/§11).
 */
export const resolveSyncedProjectName = (
  incoming: string | undefined,
  existing: string | null,
): string | null => incoming ?? existing;
```

2. Replace the `syncProjects` implementation:

```ts
    syncProjects: async (userId, projects, now) => {
      if (projects.length === 0) return;
      const ids = projects.map((project) => project.projectId);
      const { data: existingRows } = await db()
        .from('cloud_projects')
        .select('project_id, name')
        .eq('user_id', userId)
        .in('project_id', ids);
      const existingNameById = new Map(
        (
          (existingRows as { project_id: string; name: string | null }[] | null) ?? []
        ).map((row) => [row.project_id, row.name]),
      );
      await db()
        .from('cloud_projects')
        .upsert(
          projects.map((project) => ({
            user_id: userId,
            project_id: project.projectId,
            name: resolveSyncedProjectName(
              project.name,
              existingNameById.get(project.projectId) ?? null,
            ),
            updated_at: now,
          })),
          { onConflict: 'user_id,project_id' },
        );
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test -- repository.test.ts`
Expected: PASS. Then `pnpm --filter web typecheck` to confirm the Supabase query-builder types for `.select('project_id, name')` / `.in(...)` line up with how the rest of `repository.ts` already queries `cloud_projects` (mirror an existing `.select(...).eq(...)` call in the same file if the inferred row type needs an explicit cast).

- [ ] **Step 5: Commit**

Not yet.

---

### Task 9: Cross-machine regression test (spec §16, A–E)

**Files:**

- Test: `packages/memory/src/project-display-name-recovery.test.ts` (new file)

**Interfaces:**

- Consumes: `discoverClaudeMemory`, `createClaudeMemoryAdapter`, `readLocalRegistry`, `nameHintFor`, `toPortableSnapshot`, `readPortableSnapshot`, `mergePortableSnapshot` — all already exported from `@stack/memory`.

This test proves the end-to-end logical-identity model across two simulated machines without touching Cloud/CLI/web (those are covered by Tasks 4–8's unit tests): Machine A discovers and names a project at backup time; the portable snapshot it would upload carries no name and no path; Machine B, recovering that snapshot into an empty local registry, ends up with the same `projectId` but NO name hint (proving names never leak through the portable channel and must come from Cloud/Task 8's path instead) and no binding.

- [ ] **Step 1: Write the failing test**

Create `packages/memory/src/project-display-name-recovery.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeMemoryAdapter } from './adapter.js';
import { encodeClaudeProjectKey } from './project-identity.js';
import {
  nameHintFor,
  mergePortableSnapshot,
  emptyRegistry,
} from './project/registry.js';
import {
  readLocalRegistry,
  readPortableSnapshot,
} from './project/registry-store.js';

const roots: string[] = [];
const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

describe('Project display name — Machine A discovery to Machine B recovery (spec §16 A-E)', () => {
  it('names the project on Machine A, keeps the name OUT of the portable snapshot, and Machine B recovers the same projectId with no name hint of its own', async () => {
    // Machine A: a real local project directory with auto-memory, no Git remote.
    const claudeHomeA = await tempDir('claude-a-');
    const checkout = path.join(await tempDir('repos-'), 'nexus');
    await mkdir(checkout, { recursive: true });
    const vendorKey = encodeClaudeProjectKey(checkout);
    const memoryDir = path.join(claudeHomeA, 'projects', vendorKey, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, 'n1.md'), '# nexus notes\n', 'utf8');

    const stackHomeA = await tempDir('stack-a-');
    const adapterA = createClaudeMemoryAdapter({
      stackHome: stackHomeA,
      claudeHome: claudeHomeA,
      platform: process.platform,
      gitRemoteOf: async () => undefined,
      isDirectory: async (candidate) => {
        try {
          return (
            await (await import('node:fs/promises')).stat(candidate)
          ).isDirectory();
        } catch {
          return false;
        }
      },
    });

    await adapterA.backup();

    const registryA = await readLocalRegistry(stackHomeA);
    const record = registryA.projects[0];
    expect(record).toBeDefined();
    const projectId = record!.projectId;

    // A. Machine A: stable projectId minted, displayName hint = basename, no path anywhere.
    expect(nameHintFor(registryA, projectId)).toBe('nexus');

    // B. The portable snapshot (what a Cloud bundle would carry) has no name and no path.
    const snapshot = await readPortableSnapshot(stackHomeA);
    expect(snapshot).not.toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain('nexus');
    expect(JSON.stringify(snapshot)).not.toMatch(/[A-Za-z]:\\|\/Users\//);

    // C. Machine B recovers the SAME portable snapshot into an empty local registry.
    const merged = mergePortableSnapshot(emptyRegistry(), snapshot!);
    expect(merged.conflicts).toEqual([]);
    const recordB = merged.registry.projects.find(
      (p) => p.projectId === projectId,
    );
    expect(recordB).toBeDefined();

    // D/E. Machine B has the SAME projectId, but NO name hint and NO binding of its own —
    // it cannot render "nexus" until either Cloud (Task 8) supplies it or a local
    // `stak project map` creates a fresh binding. Identity never flows through the name.
    expect(nameHintFor(merged.registry, projectId)).toBeUndefined();
    expect(merged.registry.bindings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/memory test -- project-display-name-recovery.test.ts`
Expected: FAIL before Tasks 1-4 land (no `onLocalProjectResolved`/name hints at all, so `nameHintFor(registryA, projectId)` is `undefined`, not `'nexus'`). If run AFTER Tasks 1-4 (i.e., in the intended execution order, run this as Task 9 last), it should already PASS — this task is confirmation/regression coverage, not new production code.

- [ ] **Step 3: No implementation needed**

This task adds no production code — Tasks 1-4 already implement everything it exercises. If it fails, the bug is in Tasks 1-4, not here; go back and fix the earlier task.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/memory test -- project-display-name-recovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Not yet — this is the last task before the single commit.

---

### Task 10: Full validation and single commit

- [ ] **Step 1: Run every affected suite**

From the repo root (PowerShell; if `pnpm`/`turbo` fail with a "not recognized" native-binary error, first run `node "C:\Users\NT\AppData\Local\pnpm\.tools\pnpm\12.4.2\node_modules\pnpm\install.js"` once, per the known local fix):

```
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

Expected: all green. Pay particular attention to:

- `@stack/memory` — Tasks 1-4 and 9.
- `@stack/cli` — Tasks 5-7 (grep first per Task 7 Step 4 for any other `ProjectListRow` literal).
- `web` — Task 8.
- `git diff --check` (no whitespace errors): `git diff --check`

- [ ] **Step 2: Manually sanity-check the CLI output**

Build the CLI and run `stak project` in a throwaway `STACK_HOME`/`CLAUDE_HOME` with a seeded unmapped local auto-memory project (same shape as Task 9's fixture) through `stak memory backup`, confirming the rendered line shows the basename instead of `local project`, and that removing the binding (if one existed) still shows the name. This is a manual spot-check, not a new automated test — Tasks 5-7's unit tests already cover the logic.

- [ ] **Step 3: Review the diff**

```
git status
git diff --stat
```

Confirm only the files listed in Tasks 1-9 changed, plus the new test files, plus this plan document. Confirm `docs/superpowers/plans/2026-10-16-realtime-sync.md` and `packages/cli/memstk-cli-0.1.0.tgz` (pre-existing untracked files, unrelated to this work) are NOT staged.

- [ ] **Step 4: Commit**

```bash
git add packages/memory/src/project-identity.ts packages/memory/src/project-identity.test.ts \
  packages/memory/src/claude-adapter.ts packages/memory/src/git-identity-continuity.test.ts \
  packages/memory/src/project/registry.ts packages/memory/src/project/registry.test.ts \
  packages/memory/src/project/registry-store.ts packages/memory/src/project/registry-store.test.ts \
  packages/memory/src/adapter.ts packages/memory/src/project-display-name-recovery.test.ts \
  packages/cli/src/memory/project-ops.ts packages/cli/src/memory/project-ops.test.ts \
  packages/cli/src/cloud/checkin.ts packages/cli/src/cloud/checkin.test.ts \
  packages/cli/src/commands/project.ts packages/cli/src/commands/project.test.ts \
  apps/web/lib/repository.ts apps/web/lib/repository.test.ts \
  docs/superpowers/plans/2026-10-17-project-display-names.md
git commit -m "$(cat <<'EOF'
fix(memory): preserve logical project names

Capture a safe directory basename at Memory-backup discovery time (not only
from an explicit `stak project map` binding) and persist it as a
machine-local-only name hint, so a recovered-but-unmapped Project renders its
recognizable name instead of "local project" / "recovered from: local:...".
Also fixes a Cloud-sync name-erasure bug: `stak memory recover` on a second
machine, before mapping, was sending a nameless sync row that nulled out the
name another machine had already given the project in Cloud.

No projectId/identity changes, no migration — the existing nullable
cloud_projects.name column and sync path already supported this; only the
missing discovery->name link and one upsert bug needed fixing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git status
```

Do not push, publish, or tag.
