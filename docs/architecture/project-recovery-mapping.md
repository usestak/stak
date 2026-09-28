# Stack Project Recovery Mapping (Phase 15A architecture)

- **Status:** Proposed — architecture/specification only. No production behavior
  changes in this phase. Version 0.1.0 unchanged.
- **Date:** 2026-09-27
- **Companion docs:** [`project-identity.md`](./project-identity.md),
  [`project-lifecycle.md`](./project-lifecycle.md),
  [ADR 0004](./adr/0004-durable-logical-project-identity.md).
- **Grounds:** `packages/memory/src/restore.ts`,
  `packages/cli/src/memory/resolve.ts`,
  [`memory-cloud-deployment.md` §5](./memory-cloud-deployment.md).

## 1. Problem statement

Recovery restores Memory bytes; **mapping** decides _where_ (if anywhere) that Memory may
be written on this machine. The V0 restorer (`restore.ts`) already does the safe thing:
it resolves a manifest item to a fenced target only when the item's project identity
matches a candidate project on this machine, and otherwise reports `project-not-found`
and writes nothing (never merges, never overwrites — `identical`/`conflict`/`restorable`
semantics). What is missing is a model that lets **unresolved projects stay unresolved
without nagging**, lets the user **explicitly and durably map** a project later, and
resolves legacy/immutable backups (generation 3) under the new identity model.

### Real dogfood motivation

The §5 dogfood restored 7 files (portable Git identity) and correctly left 20 files
across 8 local-only projects unresolved. The previous conceptual UX — "8 projects need
mapping" — is now **too aggressive**, because (a) some of those projects are intentionally
gone (e.g. Nexus was deleted), and (b) recovered Memory is valuable even with no restore
destination. The guiding principle: **recovered Memory may remain safely stored without a
restore destination**, indefinitely.

## 2. Goals & non-goals

**Goals:** a deterministic resolution algorithm combining identity confidence + lifecycle

- availability; a non-blocking recovery UX; durable, reversible mappings; correct
  handling of multiple checkouts; explicit generation-3 compatibility; the smallest
  coherent CLI; provider-neutral design; a hard public-Stack privacy boundary.

**Non-goals:** implementing any of it; changing restore's conflict/no-overwrite
semantics; whole-disk scanning; silent guessing.

## 3. Recovery resolution algorithm

Two stages. Stage 1 establishes **identity confidence** (from
[`project-identity.md` §6](./project-identity.md)); Stage 2 applies **lifecycle +
availability** gates to decide whether to write.

### 3.1 Stage 1 — identity resolution order

For each backup project reference, resolve in this order and stop at the first that
succeeds:

```
1. stack-project-id            (marker/registry supplies prj_...)        → VERIFIED
2. strong portable identity    (single unambiguous canonical Git remote) → VERIFIED
3. confirmed durable mapping   (user-confirmed alias/relationship)       → CONFIRMED
4. historical/legacy alias     (legacy-local or historical-git claim,
                                resolved via the registry only)          → (needs binding)
5. current machine binding     (a binding already recorded here)         → resolves target
6. candidate suggestion        (heuristics: folder name, package/stack.yaml,
                                fingerprint, exact historical path)       → CANDIDATE
7. otherwise                                                             → UNRESOLVED
```

Notes:

- Step 2 is the proven behavior (`canonicalGitIdentity` → match). Ambiguous/multiple
  disagreeing remotes drop to CANDIDATE (step 6), not VERIFIED.
- Step 4 (legacy alias) yields _identity_, but a legacy-local alias is path-derived and
  never strong; it still needs a confirmed binding (step 3/5) or user confirmation before
  any write. An exact historical path is CANDIDATE only (path-reuse rule).
- Step 6 heuristics **only suggest**; they never authorize a write.

### 3.2 Stage 2 — lifecycle + availability gate

Identity confidence alone does not authorize a write. Combine with lifecycle and machine
availability:

| Confidence + lifecycle + availability          | Action                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| VERIFIED/CONFIRMED + ACTIVE + PRESENT          | Restore may proceed (still subject to restore's `identical`/`conflict` rules — never overwrite differing Memory). |
| VERIFIED/CONFIRMED + ARCHIVED + PRESENT        | Skip by default; allow explicit restore.                                                                          |
| VERIFIED/CONFIRMED + ACTIVE + UNBOUND/MISSING  | Preserve, no restore; offer mapping (not forced).                                                                 |
| CANDIDATE (any lifecycle)                      | Confirmation required before any write.                                                                           |
| UNRESOLVED (any lifecycle)                     | Preserve, no restore.                                                                                             |
| DEFERRED ("leave unavailable") on this machine | Preserve, no restore, **no prompt**.                                                                              |

This preserves invariants: no ambiguous write without confirmation (#2), missing ≠
retired (#4), no silent guessing (#16), existing conflict semantics intact (#17).

## 4. Recovery UX (non-blocking)

`stack memory recover` fetches + decrypts the backup into the private store.
`stack memory restore` then writes only what is safely resolvable and **retains the rest
without forcing any decision**. Default output, for the §5 shape:

```
$ stack memory restore

7 files restored.
20 files retained from 8 projects not available on this machine.

Run `stack project` to review them (optional — nothing is lost).
```

Exit code 0. No destructive decision is required; "retained" Memory stays in the private
store and can be mapped or restored later.

`stack project` reviews retained/unresolved projects with per-project actions:

```
Recovered Memory

Atlas                 7 files    ✓ present on this machine (restored)
Nexus                 4 files    not available on this machine
    → Map to a directory   → Leave unavailable   → Archive
<other project>       2 files    not available on this machine
    → Map to a directory   → Leave unavailable   → Archive
```

- **Default safe action requires no destructive decision.** Doing nothing preserves
  Memory.
- **"Leave unavailable"** persists a per-machine **DEFERRED** flag (Q15) so Stack does
  **not** nag on future recoveries, _without_ marking the project archived. It is cleared
  when the user later maps the project.
- **"Archive"** is a global lifecycle decision (reversible; see lifecycle doc).
- Stack never repeatedly prompts about projects the user deferred or archived.

## 5. Confirmed mappings — what exactly is confirmed (Q14)

When the user says "this recovered logical project is _this directory_," Stack persists a
**machine-local binding** plus, if applicable, a **portable identity relationship** — and
these are different things:

- **Machine-local binding** (machine-local registry): `prj_... → C:\path\here`, with
  `primary` and `lastSeen`. This authorizes restore on _this_ machine only.
- **Portable identity relationship** (portable registry, only when the user confirms a
  cross-identity equivalence, e.g. "this legacy-local project is the same as this Git
  repo"): adds/links a claim on the logical project.

Design details:

- **Provenance & confidence.** A confirmed binding is `CONFIRMED`; provenance records it
  was user-confirmed, when, and against what evidence.
- **Reversal / unmapping.** A binding can be removed (machine-local, non-destructive). An
  erroneously confirmed _identity relationship_ can be revoked in the registry.
- **Path moves.** If the bound directory moves, availability becomes `missing`; the user
  re-points the binding. The portable identity is unaffected.
- **Conflicting mappings.** Two logical projects mapped to one directory, or one strong
  identity claimed by two projects, is surfaced as a conflict (Q22) — never silently
  merged.
- **Precision:** confirming a binding does **not** globally equate an old path with a new
  path. It says "on this machine, this logical project currently lives here." The old
  path remains only a historical alias.

## 6. Multiple checkouts (Q23)

One logical project may legitimately have several working copies on one machine
(`C:\work\project`, `C:\work\project-hotfix`, `D:\experiments\project`).

- All may **bind** to one logical project (multiple machine bindings).
- Exactly one is **primary**.
- Restore targets the **primary** (or an explicitly chosen) checkout — **never all of
  them**. Claude auto-memory is keyed per directory; writing the same Memory into every
  checkout would duplicate and risk contamination. Writing to multiple targets is allowed
  only if a provider's Memory semantics make it explicitly safe (none does today).

## 7. Generation 3 compatibility path (explicit)

Generation 3 (a real Protected backup) must remain usable forever with **no rewrite**:

```
generation 3 (immutable, Protected)
        ↓ decrypt to private store as today (recover)
manifest items with git and legacy-local (local:<vendorKey>) identities
        ↓ modern resolver: Stage 1 identity resolution
git items → VERIFIED (auto);  legacy-local items → historical alias
        ↓ registry overlay (mutable, separate from the generation)
confirmed relationships / bindings / lifecycle applied
        ↓ Stage 2 gate
safe restore where authorized; everything else retained/unavailable
```

No `decrypt → rewrite manifest → re-upload` occurs. Mapping and lifecycle live in the
mutable registry, never inside the immutable generation. Newer backups additionally carry
the portable registry section; gen 3 simply lacks it and resolves via git + legacy
aliases. (Invariants #12–#14.)

## 8. CLI / UX surface recommendation

Keep the common flow trivial and add the **minimum** surface — no command exists merely
because a concept exists.

**Common flow (unchanged):**

```
stack memory backup
stack memory recover
stack memory restore     # non-blocking; retains unresolved, exits 0
```

**New (minimal):**

```
stack project                      # list logical projects: lifecycle, availability,
                                   # retained/unresolved counts (read-only)
stack project map <project> <dir>  # confirm a machine-local binding (write)
```

**Later (only when the concept is exercised):**

```
stack project archive <project>
stack project unarchive <project>
```

Recommendation: ship `stack project` (list) + `stack project map` in the first
implementation slice; `archive`/`unarchive` follow with the lifecycle slice. An
interactive mapping flow inside `stack project` is preferred over many flags. Hard delete
gets its own explicit, confirmed command in a later phase, never folded into these.

## 9. Memory integration & provider-neutral design (Q28)

The logical project sits **above** provider-specific Memory:

```
Logical Project (prj_...)
├── Claude Memory      (auto-memory, agent-memory, instructions — today)
├── future Codex Memory
├── future Cursor Memory
└── other providers
```

- **Provider-neutral identity.** Project ID, claims, and lifecycle are provider-agnostic;
  only _bindings/targets_ are provider-specific (e.g. Claude's per-directory auto-memory
  keying via `encodeClaudeProjectKey`).
- **Future manifest representation.** A manifest item keeps its portable
  `project` identity but its `provider` + `restoreTarget` describe provider placement,
  so multiple providers can map to one logical project. The current
  `provider: 'claude'` + `restoreTarget` union is the template.
- **Compatibility preserved with:** existing Git-keyed Memory, existing `local:` Memory,
  generation 3, and the current Claude adapter behavior — all continue to resolve.

## 10. Public Stack boundary (Q, public stacks)

`stack publish` publishes stack/skill artifacts for public consumption. It must **never**
expose private project registry information. Explicitly, the following stay outside every
public Stack artifact:

- Memory (any kind).
- Project **lifecycle** state.
- **Machine bindings** / filesystem paths.
- Private **Git/project identities** that are not already intentionally public.
- **Recovery mappings** and confirmed relationships.

The portable registry lives inside the _Memory backup bundle_ (private, mode-following),
which is a separate artifact from anything `stack publish` emits. (Invariant #18, #19.)

## 11. Rollout strategy & implementation phases

- **Phase 15A (this):** architecture + ADR only. No code, schema, crypto, or Cloud
  change. Version 0.1.0 unchanged.
- **Phase 15B (recommended first implementation slice):**
  1. Introduce the opaque **Project ID** and the **portable registry section** inside the
     Memory backup bundle (mode-following; Protected → encrypted). No new server table.
  2. **Machine-local binding store** under Stack home (paths never uploaded).
  3. **Non-blocking restore UX**: retain unresolved, exit 0; `stack project` (list) and
     `stack project map` (confirm binding).
  4. **Legacy-local read compatibility**: parse `local:<vendorKey>` as historical alias;
     **path-reuse hardening** — never auto-bind a legacy-local identity to a directory
     purely because the path re-encodes to the stored vendor key (CANDIDATE + confirm).
  5. Generation-3 resolution via overlay (no rewrite).
- **Phase 15C+ (later):** archive/unarchive lifecycle + private cross-machine convergence;
  Git transfer/rename reconciliation (historical+current claims with authoritative
  basis); optional opt-in `.stack/project.json` marker as corroborating evidence;
  multiple-checkout primary selection; multi-provider manifests; hard-delete /
  crypto-shred design + confirmed destructive command.

## 12. Acceptance criteria

For the eventual implementation (not this phase):

- A project moved to a new path (same Git remote) auto-restores. _(Regression guard for
  the proven behavior.)_
- A legacy-local project from generation 3 is retained, never auto-written by path, and
  restorable after an explicit `stack project map`.
- An unrelated project created at a reused historical path is **not** auto-matched.
- `restore` never overwrites/merges differing Memory; a second `restore` is idempotent.
- Unresolved projects are retained with exit 0 and no forced decision; "leave
  unavailable" suppresses future prompts without archiving.
- Archiving is reversible and deletes no Memory; hard delete is a separate, confirmed
  operation with honestly-bounded guarantees.
- Protected: the server learns nothing new about project identities/lifecycle (registry
  rides encrypted in the bundle).
- `stack publish` output contains none of: Memory, lifecycle, bindings, private
  identities, mappings.

## 13. Failure modes (recovery-specific)

- **Everything unresolved** (legacy-only backup, new machine) → all retained, exit 0,
  `stack project` explains; nothing lost.
- **Candidate conflict** (heuristics suggest two dirs) → present both; require a choice;
  never auto-pick.
- **User maps to a directory that already holds differing Memory** → restore reports
  `conflict` and skips those files (no overwrite), consistent with today's `restore.ts`.
- **Registry says present but dir vanished at apply time** → restore's apply-time
  re-check treats it as unavailable/`conflict`-safe; never partial-clobbers.

---

## Appendix A — Answers to the 30 required architectural questions

1. **What is a logical project?** A durable, opaque, provider-neutral entity representing
   "a project" independent of any path/machine/folder, identified by a random `prj_` ID
   and holding identity claims, lifecycle, historical Memory, and per-machine bindings
   (identity doc §5).
2. **Lifecycle vs machine availability?** Lifecycle = the user's global stance
   (`active`/`archived`, portable). Availability = this machine's state
   (`present`/`missing`/`unbound`/`candidate`, machine-local). Orthogonal (lifecycle doc
   §3).
3. **How is the stable project ID generated?** `prj_` + 128 bits CSPRNG, base32; not
   derived from path/user/machine/name/content; minted once, lazily, on first
   unresolvable observation (identity §5.1).
4. **Where is the canonical registry stored?** Hybrid: portable identity/lifecycle inside
   the Memory backup **bundle** (mode-following); machine bindings/paths in a
   machine-local store. No separate server table (identity §7).
5. **What metadata is portable?** Project ID, identity claims, lifecycle, confirmed
   relationships (identity §7).
6. **What stays machine-local?** Filesystem paths, bindings, last-seen availability, the
   per-machine "leave unavailable" (deferred) flag (identity §7).
7. **Should absolute paths ever leave the machine?** No (identity §7).
8. **Protected-mode registry privacy?** Registry rides inside the bundle, so Protected →
   client-side encrypted, zero-knowledge; the server learns nothing beyond existing
   Protected metadata. No server-readable project table (identity §8).
9. **How is an existing `local:` identity migrated?** Read as a historical **legacy-local
   alias**; mapped to a logical project only via registry/confirmation; never auto-writes
   by its embedded path (identity §11).
10. **How does generation 3 remain valid forever?** Resolver overlays the mutable registry
    on the immutable manifest; git auto-resolves, legacy aliases resolve via
    registry/confirmation; no decrypt→rewrite→re-upload (identity §11, mapping §7).
11. **What evidence permits automatic resolution?** A single unambiguous canonical Git
    remote, a Project ID from an authoritative registry/marker, or a prior user-confirmed
    mapping (VERIFIED/CONFIRMED) (identity §6).
12. **What evidence is candidate-only?** Folder name, package/`stack.yaml` metadata, file
    fingerprints, repo structure, exact historical path, unauthenticated marker — all
    CANDIDATE (identity §6, §12).
13. **Is an exact historical path sufficient?** No — path-reuse makes it CANDIDATE only
    (identity §12).
14. **How are confirmed mappings represented?** A machine-local binding (`prj_ → dir`,
    primary/lastSeen) plus, only on explicit cross-identity confirmation, a portable
    identity relationship; with provenance and reversibility (mapping §5).
15. **What does "leave unavailable" persist?** A per-machine **DEFERRED** flag so Stack
    stops prompting, without archiving; cleared on later mapping (lifecycle §5, mapping
    §4).
16. **How does a user retire/archive a project?** `stack project archive` — an explicit,
    global, reversible lifecycle change (lifecycle §4).
17. **How is retirement reversed?** `unarchive`; non-destructive, loses nothing (lifecycle
    §4.2).
18. **How is retirement different from deleting Memory?** Archive keeps all Memory and is
    reversible; deletion is a separate, explicit, confirmed destructive operation
    (lifecycle §4, §7).
19. **Absent on only one machine?** `unbound`/`missing` there; stays `present`/active
    elsewhere; nothing global changes (lifecycle §5).
20. **Git remote transfers?** Represented as historical + current Git claims on one
    logical project, added only with an authoritative basis (identity §9, §13-E).
21. **Copies/forks contamination prevented how?** Only strong unambiguous identity
    auto-resolves; path is never strong; restore never merges/overwrites; one strong
    identity ↔ one logical project (identity §13).
22. **Two logical projects claim one strong identity?** Conflict → refuse auto-resolution,
    surface both, require explicit disambiguation/merge; never silent (identity §13).
23. **One logical project, multiple checkouts?** Multiple bindings allowed, one primary;
    restore targets the primary/chosen checkout only, never all (mapping §6).
24. **Restore when only some projects resolve?** Restore the resolvable, retain the rest,
    exit 0, no forced decision (mapping §4).
25. **How can historical Memory stay useful for a project gone locally?** It remains in
    the private store / immutable generations and is recoverable/mappable later; recovered
    Memory needs no destination to be preserved (mapping §1, §4).
26. **How does the user later map a previously unavailable project?** `stack project map
<project> <dir>` (or the interactive flow), which records a confirmed binding (mapping
    §5, §8).
27. **Hard deletion vs immutable generations?** Cannot rewrite committed generations;
    honest guarantees = stop future inclusion + retire/soft-delete with bounded retention
    - (Protected) crypto-shred; no instant global erasure (lifecycle §7).
28. **Provider-neutral how?** Identity/lifecycle are provider-agnostic; only
    bindings/restore targets are provider-specific; manifest keeps portable identity +
    per-provider placement (mapping §9).
29. **Smallest CLI surface?** `stack project` (list) + `stack project map`; then
    `archive`/`unarchive`; hard delete separate and later (mapping §8).
30. **Phase 15B vs later?** 15B: Project ID + in-bundle registry, machine-local bindings,
    non-blocking restore + `stack project`/`map`, legacy-local read + path-reuse
    hardening, gen-3 overlay. Later: lifecycle + private sync, Git transfer reconciliation,
    opt-in marker, multi-checkout primary, multi-provider, hard-delete/crypto-shred
    (mapping §11).

---

## Appendix B — Phase 15B implementation notes (2026-09-27)

The first runtime slice (branch `phase-15b-project-identity-runtime`) implements the
foundation described above. Concrete choices, recorded for future phases:

- **Project ID** (`packages/memory/src/project/project-id.ts`): `prj_` + 128 bits of
  CSPRNG entropy encoded as 26 Crockford-base32 symbols. `mintProjectId(entropy?)`
  takes only optional raw entropy (for deterministic tests) — no path/name/content
  parameter exists, so an ID cannot be path-derived.
- **Registry model** (`project/registry.ts`): a pure module with a portable tier
  (`PortableProjectRecord` = Project ID + typed claims: `git` | `legacy-compat`) and a
  machine-local tier (`MachineBinding` = Project ID → absolute dir). Legacy path-derived
  identities travel as a **domain-separated digest** (`legacyCompatKey`,
  `stack-project-compat-v1`) so the raw absolute path is not emitted into new portable
  metadata; this is an opacity measure, explicitly **not** claimed to be secret (a digest
  of a guessable path is guessable — Protected mode still encrypts the whole bundle).
- **Bundle carriage** (`remote/bundle-codec.ts`): chose **strategy A** — a
  backward-compatible OPTIONAL `registrySha256`/`registryB64` pair on the existing
  `stack-mem-bundle-v1`. Old bundles (generation 3 and earlier) omit it and still decode;
  the snapshot file lives under the store's `manifests/` dir so it rides in the
  mode-following bundle automatically, and the server never inspects it. No Cloud schema,
  migration, table, or crypto change.
- **Backup** attaches the snapshot via `syncRegistryForBackup` (called from the Claude
  adapter's `backup()`), resolving/minting Project IDs from the manifest — including lazy
  IDs for legacy projects whose directories no longer exist. **Recover** calls
  `reconcileRegistryAfterRecover` inside `cloudRecover`: it merges a carried snapshot
  (preserving IDs, detecting strong-identity conflicts, never creating a binding) or lazily
  migrates from the manifest when none is present (generation-3 path).
- **Restore resolution** (`restore.ts`): a git identity may auto-match a live candidate
  directory by canonical remote (the proven Atlas behavior); a legacy `local:` identity is
  **never** matched by re-encoding a directory's path — it resolves only through an explicit
  binding. A strong identity claimed by two Project IDs yields the new `identity-conflict`
  status (refuse, don't merge). Existing `identical`/`conflict`/`restorable` no-overwrite
  semantics are unchanged; unresolved projects are retained (`project-not-found`) and never
  turned into errors.
- **CLI**: `stack project` (read-only list) and `stack project map <project> <directory>`
  (explicit, confirmed machine-local binding; refuses a directory whose Git identity
  conflicts). No archive/unarchive, delete, or merge commands in this slice.
- **Deferred to 15C+** (unchanged from §11): archive/retire lifecycle + private
  cross-machine convergence, Git transfer/rename reconciliation, opt-in
  `.stack/project.json` marker, multiple-checkout primary selection, multi-provider
  manifests, and hard-delete / crypto-shred.

### 15B.1 closure notes (2026-09-28)

- **Public/private boundary is tested at the real serialization layer.** A regression
  (`packages/cli/src/public-publish-boundary.test.ts`) populates a Stack home with a full
  private project registry (Project IDs, private Git claims, legacy-compat keys, a machine
  binding, unresolved-project metadata, and Memory), then runs the actual
  `preparePublish` path — `resolvePublishSource → loadLocalStack → buildPublicStackBundle`
  — against a real git-backed authoring stack and inspects both the produced bundle and the
  exact payload `applyPublish` would transmit. None of the private tokens appear. No network
  publish occurs (the client only answers `me`/`getPublicStack`).
- **Legacy-compat is a historical association, not path authority.** A `legacy-compat`
  claim only associates a logical-project record with a historical backup reference. A live
  directory sitting at the old path never promotes that claim into restore authority — an
  explicit `stack project map` (or an independent strong Git identity) is still required.
  Two records sharing one compatibility reference are a standing conflict and cannot resolve
  (and therefore cannot restore) silently.
- **Pre-registry first-upgrade convergence window.** A historical bundle with no portable
  registry has no stable Project ID. If two machines independently recover it before either
  makes a registry-bearing backup, each mints a _different_ opaque Project ID for the same
  legacy reference. This divergence is expected and safe for the first-upgrade window. When
  those registries later meet (one machine recovers the other's registry-bearing backup),
  the merge **surfaces a deterministic conflict** rather than merging: both records are
  preserved, no Memory is reassigned between Project IDs, no filesystem path becomes
  authority, machine-local bindings are untouched, Memory is retained, and restore withholds
  the ambiguous project (`identity-conflict`) instead of guessing. Reconciliation UX (letting
  the user declare the two IDs the same project) is deferred to a later phase. This is
  existing behavior, now covered by tests; no runtime change was needed.

### 15B.2 note — legacy project identification (2026-09-28)

Real Phase 15B dogfood (recovering the real Protected generation on a fresh machine)
confirmed the runtime is correct — 9 logical Project IDs lazily created, the Git-backed
project auto-resolved, 8 legacy projects safely retained as unresolved, no unsafe writes —
but exposed a manual-recovery UX gap: `stack project` rendered every legacy project as
only `local project`, so a human could not tell which Project ID corresponded to a known
historical project (e.g. Stack vs Nexus) and therefore could not safely choose an argument
for `stack project map`. File counts are not identity and must not be used to guess.

Fix: `stack project` (and `--json`) now show a **recovery reference** for legacy projects —
the historical `local:<vendorKey>` correlated **locally** from the recovered private Memory
manifest at list time. It is informational provenance only:

- It is **not** identity authority. A live directory at that historical path still does not
  auto-resolve the project; path reuse remains unsafe; `legacy-compat` remains a historical
  association; an explicit `stack project map` (or an independent strong Git identity) is
  still required to authorize a restore. Displaying the reference has **zero** effect on
  restore resolution (regression-tested).
- It is **private and local**. It is computed at display time and never persisted: it does
  not enter the portable registry snapshot, the Memory bundle, the public Stack bundle/publish
  payload, or any Cloud/server-readable field. The `legacy-compat` digest strategy and
  Protected-mode privacy are unchanged.

`historical recovery reference ≠ restore authority.` No Phase 15 architecture change.
