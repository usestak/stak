# STAK Git-Like Workflow — Architecture Audit & Design

> Status: ANALYSIS / DESIGN ONLY. No code was modified to produce this document.
> Scope: redesign of the everyday STAK workflow (`status` / `add` / `push` / `pull`) around a Git-like MACHINE → MAIN → CLOUD mental model, on top of @memstk/cli@0.1.2 (tag v0.1.2), preserving existing architecture, safety boundaries, Memory model, Project identity model, Cloud behavior, and multi-agent support.

---

## 1. Executive Conclusion

The target mental model is **already substantially implemented** in the domain layer. `main` already exists as a first-class, persisted, intentional-state concept (`environment.yaml` + `stack.lock.json`). `status` already computes untracked skills. `push` already auto-commits (no separate commit step exists or is needed — don't build one). `pull` already refuses to silently overwrite local changes. Project identity is already cleanly split into portable (Cloud) vs machine-local (binding) halves. Memory backup/recover already behaves like a one-shot push/pull.

**What's actually missing for MVP is narrow:**

1. A **default-renderer bug**: `status`/`diff` compute `untracked` but the non-verbose output path never displays it — this is the entire "32 scanned / 31 tracked / no changes" bug. Fix is UI-only.
2. A genuinely **new core operation**: incremental `stak add <skill>` / `stak add .` (no such function exists today — only full-bulk `init` and whole-Stack `use` exist).
3. **Orchestration, not invention**, for `push`/`pull` to also carry Memory (call existing `runMemoryBackup`/`cloudRecover`) and Project portable state (already separated; just needs to ride in the same bundle).
4. A **status/diff Cloud-state column**: cheap metadata call already exists (`sync-metadata.ts` + `client.getEnvironment`) — just needs surfacing in `status` output.
5. **CLI-level config model** for machine-only vs portable settings: this is a genuine gap (no such schema exists anywhere) but the brief's portable-config scope is small, so it's low-risk to add.

**This can plausibly ship as a beta soon**, but not "tomorrow" in the literal sense of the prompt — Phase 1 (status/add) is low-risk and mostly rendering + one new function; Phases 2–3 (push/pull orchestration incl. Memory/Project) are moderate risk because they touch the already-working, safety-critical conflict logic and must not regress it. Recommend: Phase 1 shippable in ~1 day, Phases 2–4 need a few days of careful integration + test updates, given how much *existing* conflict-safety behavior must be preserved byte-for-byte.

---

## 2. Current Architecture Map

```
packages/cli/src/        CLI commands + command registration (program.ts)
packages/core/src/       state.ts (main/machine/lock), status.ts, resolver.ts,
                         composition.ts (init/use/remove), cloud-push.ts,
                         cloud-pull.ts, cloud-bundle.ts, cloud-restore.ts,
                         sync-metadata.ts
packages/scanner/src/    scanner.ts (discovery), hash.ts (content ID), provenance.ts
packages/store/src/      content-addressed object store (sha256/<hash>/{content,object.json})
packages/spec/src/       zod schemas: environment.ts (manifest/lock/baseline), etc.
packages/memory/src/     backup.ts, store.ts (local manifest), remote/ (modes.ts,
                         cipher.ts, mmk.ts, kdf.ts, recovery-methods.ts),
                         project/ (project-id.ts, registry.ts)
packages/adapters/src/   codex.ts, claude.ts — one-way projection main → agent skill dirs
packages/cloud-client/   client for environments/versions/snapshots + user-stacks + public-stacks
packages/cloud-server/   server-side handlers
supabase/migrations/     environments, environment_versions, snapshots (main sync);
                         user_stacks, user_stack_versions (named Stacks — separate);
                         public_stacks, public_stack_versions, public_handles (public sharing — separate);
                         memory_backups, memory_recovery_*; cloud_projects;
                         machine_skill_versions, machine_project_presence
```

**Three distinct Cloud concepts exist today, with separate tables and client classes — this distinction must be preserved and made explicit in the new design:**

| Concept | Tables | Client | Used by |
|---|---|---|---|
| Per-account "main" sync | `environments`, `environment_versions`, `snapshots` | `CloudClient` | `stak push`/`stak pull` |
| Named/saved Stacks | `user_stacks`, `user_stack_versions` | `UserStackClient` | `stak use <name>` (private saved composition) |
| Public sharing | `public_stacks`, `public_stack_versions`, `public_handles` | `PublicStackClient` | `stak use @owner/stak`, `stak try @owner/stak` |

`stak push`/`stak pull` operate **only** on the first. `stak use`/`stak try` operate on the second/third and never touch the first directly (per audit: `use` only mutates local `main`; it never auto-pushes).

---

## 3. Exact Current Meaning of `main`

`main` is a persisted environment at `stackHome` (`resolveStackHome()` / `STAK_HOME`), comprising three files:

- **`environments/main/environment.yaml`** — `EnvironmentManifest` (zod: `packages/spec/src/environment.ts:40`): `{ schemaVersion, name, skills: ManifestSkillEntry[], stacks: StackReference[], overrides: Record<string, unknown> }`. This is the **desired/intentional composition** — the Git-like "index"/working-tree-of-intent.
- **`environments/main/stack.lock.json`** — `EnvironmentLock`: resolved per-entry `{ contentHash, preferredSource, restoration, origins }` keyed by entryId. This is the **resolved, content-addressed pin** — closest Git analogue: a committed tree object.
- **`state/machines/<machineId>/environments/main.json`** — `MachineEnvironmentBaseline`: last-observed on-disk locations per entry. This is machine-scoped, **not portable** — it's "where did we last see this on *this* disk," analogous to a local working-tree cache, never shipped to Cloud.

This is **already exactly the "intentional local STAK" layer** the brief wants. No new concept is needed for Skills; `main` is not conflated with "whatever the scanner currently finds" — it's a separately persisted, deliberately-mutated file.

---

## 4. Why Current `status`/`diff` Miss a Newly Discovered Skill

**They don't, structurally — the bug is in the default renderer, confirmed independently by two forks.**

- `statusMainEnvironment` (`packages/core/src/status.ts:110`) takes a `scanResult: ScanResult` as an **input parameter** and already computes `status.untracked` (lines 220–236): any valid scanned skill whose `contentHash` isn't in the lock, and wasn't matched as a replacement for an existing tracked entry (that case becomes `modified`, not `untracked`).
- `diffMainEnvironment` (`status.ts:309`) is a thin wrapper over the same status computation.
- **The non-verbose renderers** (`ui/environment.ts` `renderStatus`, and `renderDiff`'s `total = missing.length + modified.length + uncertain.length`) **never read `status.untracked`/`summary.untracked`**, and `diff`'s "total changes" count explicitly excludes untracked. Only `--verbose` renders the "Untracked" section.
- The scanner and store already **agree on identity** (both hash full-directory content as `sha256:<hex>` — scanner's `hashSkillDirectory` is the same function family the store uses to key objects), so there's no remapping problem between "what the scanner calls it" and "what main calls it."

**Fix for MVP: surface `untracked` (and `invalidSkills`, `placementDrift`, which already exist on `EnvironmentStatus` too) in the default, non-verbose output.** This is a UI change in the CLI rendering layer, not a core/schema change.

---

## 5. Proposed MACHINE → MAIN → CLOUD Model

### A. MACHINE (what physically exists right now, recomputed every run)

| Category | Representation today | Notes |
|---|---|---|
| Skills | `ScanResult` from `scanSkills` (packages/scanner) — ephemeral, not persisted except the machine baseline cache | Already the right shape; ID = `contentHash` |
| Memory | `DiscoveredMemoryItem[]` from native scan (packages/memory) | Ephemeral scan, same pattern as Skills |
| Projects | Local directory + git-remote/other claim, resolved via `resolveProjectForIdentity` | Directories aren't "discovered" in bulk today in the same sense as Skills — verify this is sufficient for `status`'s "3 projects discovered" example (see §13 gap) |
| Config | No distinct machine-local config schema exists today | Genuine gap — see §6 |
| Machine-only state | `machine.json` (machineId, platform, arch), `MachineEnvironmentBaseline` (last-observed locations), `local-recovery-state.ts` (which Memory generation local state came from) | Already correctly excluded from anything portable |

### B. MAIN (deliberately chosen, persisted locally, not yet necessarily synced)

| Category | Representation today | Gap for MVP |
|---|---|---|
| Skills | `environment.yaml` + `stack.lock.json` | None — reuse as-is |
| Memory | `memory/manifests/current.json` local manifest (content-addressed, written by `runMemoryBackup`) | None — this **is** already a MAIN-equivalent for Memory, confirmed by the Memory fork |
| Projects | `LocalRegistry` → `PortableProjectRecord[]` (projectId, claims, lifecycle) — already distinct from `MachineBinding` (local-only path binding) | None — the portable/local split already exists; `toPortableSnapshot()` already strips bindings |
| Config | Doesn't exist | Need to define: which CLI-level settings are "desired STAK composition / portable settings" vs "agent install paths / absolute paths" (see §6) |
| Machine-only state | N/A by definition | N/A |

### C. CLOUD (last intentionally synced version)

| Category | Representation today | Notes |
|---|---|---|
| Skills | `environments` / `environment_versions` / `snapshots` tables, synced via `CloudClient.commitEnvironmentVersion` | Already immutable-version-chain, already digest-compared for conflict detection |
| Memory | `memory_backups` / generation chain (server-side backend, not read in this audit) | Already a monotonic, immutable generation chain with optimistic concurrency |
| Projects | `cloud_projects` table | Portable project records already live here (per Project-identity fork + prior memory on the display-name backfill fix) |
| Config | N/A yet | To be added only for the portable subset identified in §6 |

**Key architectural decision already made for you by the existing code and worth locking explicitly: Skills/Memory/Projects each have their own MACHINE/MAIN/CLOUD triad with slightly different mechanics (file-based lock for Skills, content-addressed manifest for Memory, ID-registry for Projects) — the new `status`/`add`/`push`/`pull` commands should be a thin orchestration layer over three domain-specific triads, not a single unified staging engine.** Attempting to unify them into one generic staging abstraction would be new architecture the brief explicitly says to avoid ("Do not assume file-level staging is required").

---

## 6. Config Model — Genuine Gap

No distinct STAK-level config schema distinguishing portable vs machine-local settings exists anywhere in `packages/core/src` or `packages/shared/src` today. This needs to be designed, but the brief's own scope note says not to invent portability rules without tracing existing code first — and tracing confirms there is simply nothing there yet to be cautious about breaking. Recommendation: keep this out of MVP critical path entirely. If `stak add .`/`status` need to report "config discovered," treat all current config as machine-local by default (safe default) and defer a portable-config schema to a later phase; nothing in the brief's MVP list strictly requires it.

---

## 7. Command Semantics Table

| Command | Reads Machine? | Reads Main? | Reads Cloud? | Changes Machine? | Changes Main? | Changes Cloud? | Status today |
|---|---|---|---|---|---|---|---|
| `status` | Yes (scan) | Yes | Yes (cheap metadata) | No | No | No | Core ready; renderer needs untracked + Cloud-state surfaced |
| `diff` | Yes (scan) | Yes | Optional | No | No | No | Same gap as status |
| `scan` | Yes (scan) | No | No | No | No | No | Unchanged — remains diagnostic-only |
| `add <skill>` | Yes (via status's untracked) | Yes | No | No | Yes | No | **Does not exist — must build** |
| `add .` | Yes | Yes | No | No | Yes | No | **Does not exist — must build**, generalized from `add <skill>` |
| `init` | Yes | No (creates) | No | No | Creates | No | Unchanged — bulk bootstrap only, keep as escape hatch |
| `use <source>` | No | Yes | Yes (fetches Stack/public source) | No | Yes | No | Already correct — confirmed "added to main," no auto-push |
| `remove` | No | Yes | No | No | Yes | No | Already correct |
| `push` | No (reads main, not raw machine) | Yes | Yes (conflict check) | No | No | Yes (creates version) | Already auto-commits; extend to include Memory/Project |
| `pull` | No | Yes (conflict check) | Yes | No | Yes (restores) | No | Already conflict-safe; extend to orchestrate Memory/Project + become "new machine" path |
| `try <source> -- <agent>` | No | No | Yes (fetches source) | Temp only | No | No | Unchanged |
| `run <agent>` | No | Yes (projects main) | No | Yes (writes agent skill dir — projection, not "change") | No | No | Unchanged |
| `memory backup` | Yes | N/A (becomes the Memory main write) | No | No | Yes (writes local manifest) | Yes (creates generation) | Already behaves like Memory-scoped push |
| `memory recover` | No | No | Yes | No | Yes (restores local manifest) | No | Already behaves like Memory-scoped pull |

---

## 8. Exact `stak add <skill>` Design

**No existing function does this; nearest reusable logic is `initializeMainEnvironment`'s per-skill ingest loop** (`packages/core/src/initialize.ts:122-220`), which already does: ingest into content store → compute content hash → select restoration strategy → push a manifest entry. That loop needs to be factored into a standalone function operating on **one entry at a time**, callable from both `init` (bulk, unchanged behavior) and the new `add`.

Proposed signature (illustrative, not final code):

```
addSkillToMain(stackHome, { entryId | discoveredSkill }, opts?) -> AddResult
```

Resolution steps:
1. Locate the target among `status`'s already-computed `untracked` (preferred — avoids re-scanning) or accept a name/path directly and resolve against a fresh scan if not found (collision-safe: error if the name matches more than one untracked hash — this mirrors the resolver's existing name-collision detection in `resolver.ts`).
2. Reuse `ingestSkill`/content-store identity check — if content already exists in the store (same hash, different location), **dedupe automatically** (this is exactly what the store already guarantees via `verifyStoredSkill`).
3. Push a new `ManifestSkillEntry` into `environment.yaml` (direct skills, not a Stack layer), recompute `stack.lock.json` via the existing resolver.
4. **No Cloud mutation** — confirmed required by the brief and consistent with `remove`'s existing precedent.

**Collision handling:** reuse the resolver's existing required/optional-conflict semantics (`resolver.ts:25-178`) unchanged — adding a skill that collides by name with a different hash already-in-main should surface the same `conflicts[]`/`skipped` reasoning the resolver produces for Stack-layer collisions today. Don't invent new conflict categories.

---

## 9. Exact `stak add .` Design

`stak add .` = "add every entry in `status`'s current `untracked[]` list" (Skills), looped through the single-entry `addSkillToMain` above, **plus** (per brief, allowed to be coarse-grained for MVP):

- Memory: no staging needed — `stak add .` is a no-op for Memory (native scan is already "everything eligible," confirmed by the Memory fork; finer-grained selection would be new architecture the brief explicitly says to avoid).
- Projects: similarly treat "all locally-bound, not-yet-portable-registered projects" as auto-included — the registry/binding split already makes this safe (binding data never leaves the machine regardless).

So concretely, `stak add .`'s only *new* logic is "loop untracked skills through add"; Memory/Project don't need an add step at all for MVP because they have no staging concept to begin with — they become fully "added" at `push` time directly from machine state (see §10).

---

## 10. Push Semantics

**Skills:** unchanged — `preparePush`/`applyPush` (`cloud-push.ts`) already serialize only `main` (via `buildCloudEnvironmentBundle`), already auto-create an immutable version (`commitEnvironmentVersion`) with no separate commit step, already detect `unsynced-remote`/`remote-newer` conflicts fail-closed. The Git-backed-content-upload gap mentioned in prior project memory (obs 2575/2576) is **already fixed** in current code — every skill's content hash is included in `contentUploadRequirements` regardless of restoration strategy.

**Memory extension:** `stak push` should additionally invoke the existing `runMemoryBackup` → `standardCloudBackup`/`protectedCloudBackup` chain (`packages/memory/src/backup.ts:190`, `remote/modes.ts:76,96`) via the existing CLI orchestration layer at `packages/cli/src/memory/cloud-ops.ts`. This is wiring, not new design — that file already composes "safe local backup, then Cloud backup when authenticated" as one operation.

**Project extension:** portable project records already ride inside the Memory bundle/registry (`toPortableSnapshot()`); no separate "push project" step should be invented — Project sync should simply happen as a side effect of the Memory push, consistent with "Project is a stable logical Cloud identity for project-specific Memory."

**Net result:** `stak push` becomes an orchestrator calling (1) existing Skill push, (2) existing Memory backup (which already carries Project portables) — not a new unified bundle format.

---

## 11. Pull / New-Machine Semantics

**Skills:** unchanged — `preparePull`/`applyPull` (`cloud-pull.ts`) already produce `create|replace|noop|conflict` modes and already refuse to overwrite `unsynced-local`/`local-changes` conflicts. This already satisfies the brief's conflict-safety examples #1 and #2.

**Memory:** `stak pull` should invoke `cloudRecover` (`remote/modes.ts:126`) via the same `cloud-ops.ts` orchestration layer — this already restores a generation into the local manifest and already runs `reconcileRegistryAfterRecover`, which is the existing mechanism that resolves Project bindings post-recovery.

**New-machine recovery path (`stak login && stak pull && stak run claude`):** becomes: (1) Skill pull (`create` mode, since no local main exists), (2) Memory recover (latest generation), which already internally reconciles the Project registry. **No new Project-recovery mechanism needs to be built** — it already exists and is already invoked by `cloudRecover`.

**Gap:** `preparePull` currently answers only "Skills ahead/behind/conflict" — the orchestrating `push`/`pull` commands need to run both sub-operations and present one combined status/result, but each sub-operation's safety logic is reused unchanged.

---

## 12. Use / Try / Run Semantics

All three are **already correct today**, no change needed structurally:

- `use <source>`: `prepareUse`/`applyUse` (`commands/use.ts:56-137`) already writes directly into main with no separate add step and an explicit "no agent bindings changed" comment, i.e., no Cloud push, no projection triggered. Confirmed for both local-path and public (`@owner/stak`) sources per the audit.
- `try <source> -- <agent>`: isolated runtime dirs, explicit `cleanupTry` always called, never touches `loadMainEnvironment` or any cloud client.
- `run <agent>`: `loadRunEnvironment` = `projectedLocalEnvironment(loadMainEnvironment(...))` — read-only projection into agent-specific skill directories via adapters (`packages/adapters/src/codex.ts:238` `planBindings`), confirmed one-way (main → agent dir) and never fed back into scan/add as a "change."

**Minor flag (not a blocker):** confirm the Skill scanner's root list does not itself include `~/.claude/skills`/`~/.agents/skills` as discovery roots — if it does, `run`'s projection output would self-ingest as a false "untracked" skill on the next `status`. Verify before shipping Phase 1's renderer fix (quick grep, not a redesign).

---

## 13. Memory Integration Strategy

Memory already has a working three-layer split — **this is the smallest-risk integration point in the whole project**:

- MACHINE = native scan (`DiscoveredMemoryItem[]`)
- MAIN = local manifest at `memory/manifests/current.json`, written by `runMemoryBackup`
- CLOUD = remote generation (monotonic, immutable, optimistic-concurrency via `expectedParent`)

`runMemoryBackup` + `standardCloudBackup`/`protectedCloudBackup` already behave exactly like "push: commit + sync in one step, no separate commit command." `cloudRecover` already behaves exactly like "pull: safe restore with historical-staleness detection" (`isHistoricalRecovery()` in `local-recovery-state.ts:83`). The existing orchestration layer `packages/cli/src/memory/cloud-ops.ts` (`MemoryCloudDeps`) is the integration point `stak push`/`stak pull` should call into directly.

**Do not build file-level Memory staging** — confirmed unnecessary; "all discovered native items + carried-forward previous items" is already the existing, correct unit of change, and the brief explicitly permits `add .` to be sufficient here.

**Tests that lock current behavior and must not regress:** `historical-recovery.test.ts`, `backup-preservation-acceptance.test.ts`, `lifecycle-portability.test.ts`, `cloud-ops.test.ts`, `cloud-ops-passkey.test.ts` (all under `packages/cli/src/memory/`).

---

## 14. Project Integration Strategy

Already cleanly split, already correct, nothing to redesign:

- Canonical identity: `mintProjectId()` (opaque 128-bit ID, independent of path/machine/content) — `packages/memory/src/project/project-id.ts:54`.
- Portable half: `PortableProjectRecord` (projectId, claims, lifecycle) — travels in the Memory bundle, `toPortableSnapshot()` strips all bindings/paths before anything leaves the machine.
- Machine-local half: `MachineBinding` (projectId → dir) in `LocalRegistry`, persisted at `memory/projects-local.json`, a STATE_MARKER, never serialized portable.
- Cross-machine differing directories already handled — bindings are keyed by `projectId`, not path; `mergePortableSnapshot` never touches bindings on merge.

**Action needed:** none beyond making sure `status`'s "Projects: N discovered" line (per the onboarding-target example) reads from the existing local registry/binding resolution rather than inventing a new discovery mechanism. Confirm the exact function that enumerates locally-bound-but-not-yet-portable projects before wiring status's output (this wasn't fully traced — flag as a Phase-3 verification step, not a redesign risk).

---

## 15. Conflict Rules

All six of the brief's conflict examples map onto **already-implemented** mechanisms:

1. Machine has unadded local changes, Cloud is newer → pull: already handled, `local-changes`/`unsynced-local` conflict kinds in `cloud-pull.ts` block it.
2. Main has intentional changes not pushed, Cloud advanced elsewhere → push: already handled, `unsynced-remote`/`remote-newer` conflict kinds in `cloud-push.ts` block it, not bypassed by `--yes`.
3. Same Skill on machine differs from main → status: already computed as `modified` (status.ts).
4. Skill removed physically from machine but remains in main → status: need to confirm exact status category (likely falls under `missing`/`placementDrift` — confirm exact field name before Phase 1 ships; this is a verification task, not new design).
5. Skill changed in place → already `modified` per #3.
6. Memory changed while main/Cloud differ → **already handled** by `isHistoricalRecovery()` — a push/recover warns before silently superseding newer cloud data.

**No new conflict-detection logic needs to be invented.** The work is orchestration (running the existing checks for Skills + Memory together and presenting one combined report) and renderer surfacing, not new safety mechanisms.

---

## 16. Proposed CLI Output Examples

```
$ stak status
STAK: main

Changes not added

Skills
  + new-skill

31 tracked
1 untracked

Cloud
  up to date with main
```

```
$ stak add new-skill
Added new-skill to main.

$ stak status
STAK: main

Ready to push

Skills
  + new-skill

Cloud
  1 change behind
```

```
$ stak push
Pushed main to STAK Cloud. (v12 -> v13)

$ stak status
STAK: main

Nothing to push. Working tree clean.

Cloud
  up to date with main
```

```
$ stak status           # modified skill in place
STAK: main

Changes not added

Skills
  ~ frontend-design   (content changed on disk)

Cloud
  up to date with main
```

```
$ stak status           # skill removed from disk, still tracked
STAK: main

Changes not added

Skills
  ! impeccable   (tracked in main, missing on disk)

Cloud
  up to date with main
```

```
$ stak push              # main ahead of Cloud
Pushing main to STAK Cloud...
Pushed. (v4 -> v5)
```

```
$ stak status            # Cloud ahead of main (someone else pushed, or another machine)
STAK: main

Cloud
  2 changes ahead of main — run `stak pull` to update

$ stak pull
STAK Cloud is ahead of main (2 versions). Pulling...
Updated main. (local v4 -> v6)
```

```
$ stak push              # conflict case
Push rejected: STAK Cloud has changes not reflected in main.
Run `stak pull` first, resolve any conflicts, then push again.
```

```
$ stak status            # Memory changes
STAK: main

Memory
  3 files changed since last backup

Cloud
  up to date with main
```

```
$ stak status            # new user before first push
STAK: main

Changes not added

Skills
  + animate
  + impeccable
  + frontend-design

Memory
  14 files discovered

Projects
  3 projects discovered

Nothing has been pushed to STAK Cloud.
```

```
$ stak pull              # fresh machine before pull
No local main found. Pulling latest from STAK Cloud...
Restored main. (v6)
Recovering Memory... done (generation 9).
Recovering Projects... done (3 projects).

$ stak run claude
```

```
$ stak use @owner/stak
@owner/stak added to main.
(Run `stak push` to sync this to your STAK Cloud.)
```

```
$ stak add .
Added 3 Skills to main.
Memory: nothing to add (always included).
Projects: nothing to add (always included).
```

---

## 17. Backward Compatibility

- `scan`, `init`, `use`, `remove`, `try`, `run`, `memory *`, `project *` commands: **keep exact current behavior**, don't rename or remove.
- `status`/`diff` existing `--verbose` output and JSON/machine-readable output modes (if any — verify before Phase 1) must still be available; only the **default, human, non-verbose** rendering changes to surface `untracked`.
- Existing Memory tests listed in §13 lock current output — any new `push`/`pull` wiring must be additive (new orchestration call sites), not a rewrite of `cloud-ops.ts`'s internals.
- Existing push/pull conflict error types (`LocalEnvironmentConflictError`, etc.) and their messages should not change shape, only be extended to also report Memory-side conflicts alongside.

---

## 18. Required Schema / API / Migration Changes

- **No Supabase schema changes required for MVP** — `environments`/`environment_versions`/`snapshots` already support everything push/pull need; Memory's generation tables already exist; Project portable records already exist in `cloud_projects`.
- **No `EnvironmentManifest`/`EnvironmentLock` schema changes required** for `add <skill>`/`add .` — they write into the existing manifest shape.
- **Possible new (local-only) schema:** if a portable-config model is added later (§6), it would need a new manifest field (e.g. `overrides` is already an open `Record<string, unknown>` escape hatch in `EnvironmentManifest` — config could piggyback there without a schema migration at all).
- **CLI output schema:** if `status`/`diff` support a `--json` machine-readable mode today, its shape must gain `untracked`/Cloud-state fields in a backward-compatible (additive) way — verify current JSON shape before Phase 1.

---

## 19. Test Plan

**Keep passing unchanged (regression gate):**
- All existing `packages/cli/src/memory/*.test.ts` listed in §13.
- Existing `cloud-push`/`cloud-pull` conflict-kind tests (`unsynced-remote`, `remote-newer`, `unsynced-local`, `local-changes`).
- Existing resolver conflict tests using `fixtures/staks/required-conflict`, `optional-conflict`, `extends-cycle`.
- Existing scanner tests using `fixtures/skills/*` (invalid-frontmatter, missing-description, missing-name, duplicate-copy, same-name-different-content, nested-skill, with-assets, with-script).

**New tests needed:**
- `status`/`diff` default-renderer output includes `untracked`/`invalidSkills`/`placementDrift` sections (regression test pinning the exact "32 vs 31" scenario from the brief).
- `addSkillToMain` unit tests: single add, `add .` bulk add, dedupe-by-hash, name-collision-with-different-hash (reuses resolver conflict fixtures), add of an invalid skill (should be rejected, mirroring `init`'s existing validity gate).
- `push`/`pull` orchestration tests: push triggers both Skill-push and Memory-backup; pull on a fresh machine triggers Skill-pull (`create` mode) + Memory-recover + confirms Project reconciliation ran.
- Conflict-safety integration test: Memory changed while Cloud/main differ → `isHistoricalRecovery` warning surfaces through the new combined push/pull report.

---

## 20. Phased Implementation Plan

### Phase 1 — Status/Add (Skills only)
**Goal:** `status`/`diff` surface untracked/modified/missing by default; `stak add <skill>` and `stak add .` exist.

Files:
- `packages/cli/src/ui/environment.ts` — extend `renderStatus`/`renderDiff` default paths to include `untracked`, `invalidSkills`, `placementDrift` sections (already computed, just not rendered).
- `packages/core/src/initialize.ts` — extract the per-skill ingest step out of `initializeMainEnvironment`'s loop into a standalone `ingestAndRegisterSkill(entry)`-shaped helper, reused by both `init` and the new add path.
- New: `packages/core/src/add.ts` (or similar) — `addSkillToMain(stackHome, target, opts)` and `addAllToMain(stackHome, opts)`, built on the extracted helper + resolver's existing conflict logic.
- New: `packages/cli/src/commands/add.ts` — registers `stak add <skill>` / `stak add .`, wired in `program.ts`.

Behavior changes: default status/diff output changes (additive, more informative — verify no snapshot tests hard-pin the old "No changes." text without `--verbose`; update those if present). New `add` command, no existing command changes shape.

Schema changes: none.

Tests: as in §19, status/diff rendering + `add` core tests.

Compatibility risk: **low** — purely additive command + rendering fix; main risk is any test or doc that currently asserts the old (incomplete) status/diff output text.

### Phase 2 — Push/Pull Orchestration + Cloud Sync State in Status
**Goal:** `status` shows Cloud ahead/behind; `push`/`pull` remain Skills-only in this phase but get their conflict-safety output unified with the new status renderer language.

Files:
- `packages/core/src/status.ts` — add a cheap Cloud-state lookup (reuse `sync-metadata.ts` + `client.getEnvironment`) into `EnvironmentStatus`, no bundle download.
- `packages/cli/src/ui/environment.ts` — render the new Cloud-state field ("up to date" / "N ahead" / "N behind" / "conflict").
- `packages/cli/src/commands/push.ts` / `pull.ts` — no logic changes, just confirm output copy matches the new status vocabulary.

Behavior changes: `status` now makes one additional cheap network call when authenticated (must handle offline/unauthenticated gracefully — fall back to "not checked").

Schema changes: none.

Tests: status output includes Cloud state; offline fallback test.

Compatibility risk: **low-medium** — new network call path in status needs careful error handling so `status` never fails outright when Cloud is unreachable (must degrade, not throw).

### Phase 3 — Memory/Project Integration into Push/Pull
**Goal:** `stak push`/`stak pull` orchestrate Memory backup/recover (which already carries Project portables) alongside Skills.

Files:
- `packages/cli/src/commands/push.ts` — after Skill push succeeds, invoke the existing `MemoryCloudDeps` backup path from `packages/cli/src/memory/cloud-ops.ts`.
- `packages/cli/src/commands/pull.ts` — after Skill pull succeeds (or on fresh-machine `create` mode), invoke the existing `cloudRecover` path via `cloud-ops.ts`.
- `packages/core/src/status.ts` (or a new combined-status module) — add "Memory: N files discovered/changed" line, reusing Memory's own discovery/diff primitives (don't reimplement).

Behavior changes: `push`/`pull` now have multi-step output (Skills, then Memory/Projects) — must present partial-failure clearly (e.g., Skill push succeeds but Memory backup fails — don't roll back Skills, just report both results, consistent with each domain's independent conflict-safety).

Schema changes: none.

Tests: orchestration tests from §19; explicit partial-failure test (Skill push ok, Memory backup fails — confirm clear error, no silent swallow).

Compatibility risk: **medium** — this is the highest-value but highest-attention-needed phase, since it changes the observable behavior of `push`/`pull` (more side effects per invocation) even though no individual safety mechanism is altered.

### Phase 4 — CLI UX / Help / Docs / Tests
**Goal:** finalize copy, `--help` text, README/docs updated to the new mental model; full regression pass.

Files:
- `packages/cli/src/program.ts` — command descriptions/help text.
- Root `README.md` / `docs/` — update onboarding examples to match §16.
- Full test suite run across all packages.

Behavior changes: none (docs/copy only).

Schema changes: none.

Tests: full suite; manual smoke test of the three target flows (existing-laptop onboarding, new-machine recovery, public-STAK try/use/push).

Compatibility risk: **low**.

---

## 21. Estimated Implementation Complexity

- Phase 1: **Small** (1 new core function + 1 new command + renderer fix). Most of the hard domain logic (identity, resolver, store) already exists and is reused unchanged.
- Phase 2: **Small–Medium** (one new cheap network call + rendering; main cost is graceful-degradation handling).
- Phase 3: **Medium** (orchestration across two already-safe subsystems; the care is in output/error presentation, not new safety logic since none needs to be invented).
- Phase 4: **Small** (copy/docs/test cleanup).

Overall: **Medium** project, **not** a rewrite — because audit confirms the hard parts (conflict detection, content addressing, project identity separation, memory generations) are already built and correct.

---

## 22. Highest-Risk Items

1. **Partial-failure UX in Phase 3** — push/pull now does more than one thing per invocation; must not silently hide a Memory-backup failure behind a successful Skill push, or vice versa.
2. **Status's new Cloud-state network call must degrade gracefully offline** — a command currently documented as "no mutation, should just work" must not start failing when unauthenticated/offline.
3. **Any existing test or doc snapshot that hard-pins the current (incomplete) "No changes." status/diff text** — must be located and updated in Phase 1, or CI breaks on an otherwise-correct fix.
4. **Scanner self-ingestion of agent projection directories** (`~/.claude/skills` etc.) — unverified; if the scanner root list includes these, Phase 1's renderer fix could surface false "untracked" entries for skills `run` just projected. Verify before shipping Phase 1.
5. **`stak add <skill>` collision resolution UX** — reusing the resolver's required/optional-conflict semantics is architecturally right, but the CLI must present these collisions in the new Git-like vocabulary (not the resolver's raw internal reason strings) — a copy/polish risk, not a safety risk.

---

## 23. Recommendation on Beta Timing

**Not literally tomorrow**, but close: Phase 1 alone (status/diff rendering fix + `add`) is genuinely small and could ship within a day once scoped, and it alone fixes the headline "32 vs 31" bug and delivers `stak add`. Phases 2–3 (Cloud-state in status, push/pull orchestration) are the real work and deserve a few focused days given how much *already-correct* conflict-safety behavior must be preserved exactly. Recommend shipping **Phase 1 as a fast-follow patch release first** (low risk, high perceived-value fix), then Phases 2–3 as the actual "new workflow" beta.

---

## 24. Decisions Needed Before Coding

1. **Confirm Phase 1 can ship alone as an interim release**, or must all four phases land together for the beta announcement.
2. **Confirm whether `status`'s existing `--verbose`/JSON output (if any) is considered a public/stable API** — affects how carefully Phase 1's renderer change must preserve old shapes.
3. **Decide exact Memory/Project line format in `status`** (the brief's examples show "14 files discovered" / "3 projects discovered" pre-first-push, vs "N files changed since last backup" post-first-push) — confirm whether Memory needs its own lightweight diff-against-last-backup count for status, or whether "always show current discovery count" is acceptable for MVP (cheaper, per audit's "no staging needed" conclusion).
4. **Decide config-model scope for MVP** (§6) — confirmed no existing schema; is it fully deferred, or does the beta need even a minimal portable/machine-local distinction surfaced in `status`?
5. **Confirm whether `stak add <skill>`'s collision behavior should ever be allowed to *replace* an existing main entry** (e.g., re-adding a skill whose content changed in place) vs. requiring `remove` + `add` as two explicit steps — the brief's `modified` status category suggests "re-add to accept the on-disk version" might be a natural `add <skill>` behavior worth confirming explicitly.
