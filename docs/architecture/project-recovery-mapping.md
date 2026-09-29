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

### 15B.3 note — unresolved Memory continuity across backups (2026-09-28)

Real Phase 15B dogfood recovered the real Protected generation on a fresh machine
(27 files / 9 projects), natively restored only the resolvable projects (9 files / 2
projects: a Git-backed project + one explicitly mapped legacy project), and correctly
retained the other 18 files across 7 unavailable projects in Stack's private store. The
open risk before creating a new generation: the pre-15B.3 `stack memory backup` rebuilt
its manifest **solely from the native scan**, so the next backup would have silently
dropped those 18 unresolved files (their content-addressed objects survive on disk, but
an unreferenced object is not bundled).

Fix (continuity composition): the next backup is composed as the current native scan
**plus** previously backed-up Memory whose project resolves as unavailable/unresolved on
this machine, carried forward **unchanged**. Selection reuses the exact restore authority
(`planMemoryRestore`): a previous item is retained only when its project classifies as
`project-not-found` or `identity-conflict`; items whose project is available are covered
by the fresh native scan (current versions win — the existing model; no new deletion
semantics are introduced for available projects). Carry-forward:

- operates through the logical Project model, never by old-path/folder/vendor-key
  matching; it preserves the Project ID, bytes/hash, and portable claims, and creates
  **no** binding and marks nothing available. A path-reused Nexus-style project stays
  unresolved yet its Memory survives into the new bundle.
- is **preservation only** — it never restores unavailable Memory into Claude, never
  recreates source-machine paths, and identity-conflict Memory is retained without being
  resolved.
- fails **closed**: `runMemoryBackup` verifies every carried-forward object is present
  before committing the manifest (written last, atomically), so a composition/validation
  failure leaves the previous local backup intact and no partial Cloud generation is
  created.

The new backup still carries the portable registry snapshot (all Project IDs
represented; machine bindings/paths never included), works under both Standard and
Protected privacy, and upgrades an old no-registry bundle to a registry-bearing one
without losing unresolved Memory. `stack memory backup --dry-run` previews the
composition (native / carried-forward / final counts + privacy) without any mutation.
`unavailable != deleted`; intentional deletion of an unavailable project's Memory is
deferred to later lifecycle/deletion design. No Phase 15 architecture change.

A non-blocking dogfood note was also recorded: the first `memory recover --passkey`
attempt hit an expired recovery session and an immediate retry succeeded (see
`memory-cloud-deployment.md`); passkey/session behavior was not changed here.

### 15B.4 note — Git identity continuity for restored native Memory (2026-09-28)

Real Phase 15B dogfood surfaced an identity-continuity bug (caught by `memory backup
--dry-run` **before** any Cloud mutation; generation 3 stayed latest and intact). After
recovering a Git-backed project and restoring it natively, the native files sit under a
vendor key derived from the recovery machine's absolute checkout path. The checkout still
carried the correct Git remote, and `memory scan` (run from inside the checkout) resolved
it to `github.com/<owner>/<repo>` correctly — but a later `stack memory backup` run from a
**different working directory** did not: auto-memory Git resolution depended on the current
working directory (candidate = cwd + siblings). With no candidate match, discovery fell
back to `local:<vendor-key>`, so `syncRegistryForBackup` (a legitimate registry writer)
minted a **second** logical project for the same files and carried the recovered Git-keyed
items forward as "unavailable" — inflating the preview from 9/27 to 34/10.

Root cause: two production paths used different project-resolution inputs. Fix: auto-memory
Git resolution is now **working-directory-independent** — `discoverClaudeMemory` resolves a
native project's strong Git identity from the project's **own checkout**, reconstructed
from the vendor key (`reconstructProjectDir`, a filesystem-validated inverse of
`encodeClaudeProjectKey` that handles hyphenated leaf names) and probed with an injected
`gitRemoteOf`. Because `scan`, `backup`, and `backup --dry-run` all discover through this
one path, they now agree. When a native item resolves to a strong Git identity that the
registry already holds, it maps to the existing Project ID; a new local Project ID is
minted only when no strong identity can be established (legacy/mapped projects and
path-reuse cases are unchanged). No automatic Project-ID merge was added; genuine
strong-identity conflicts still surface as conflicts.

Registry writer boundaries (verified in code): **read-only** — `stack project`,
`stack project --json`, `memory scan`, and `memory backup --dry-run` (they only read
`projects-local.json`, `project-registry.json`, and the manifest; regression-tested
byte-for-byte). **Mutating** — `recover` (reconcile/merge the portable registry),
`stack project map` (machine binding), and a real `memory backup` (commit updated
manifest + registry snapshot). Double-counting is additionally prevented by the existing
`logicalId` overlay dedup (native wins), so even the carry-forward path cannot re-add a
project the native scan already covers.

Environment note (not a code change): during diagnostics `git -C <repo>` reported dubious
ownership because the fenced dogfood HOME lacked the user's normal Git `safe.directory`
context. This is separate from the identity bug; no Git global configuration or
`safe.directory` change was made in this patch.

### 15B.4 closure — ambiguity hardening + corrected forensics (2026-09-28)

Two closure items from review of commit `153a6cc`:

**Vendor-key reconstruction is fail-closed on ambiguity.** `encodeClaudeProjectKey` is
lossy (`:`, `\`, `/` all become `-`), so a key can decode to more than one real
directory (e.g. `…-a-b-c` → `a-b\c` or `a\b-c`). `reconstructProjectDirs` now enumerates
**every** existing directory chain a key decodes to (no ordering/length/name preference,
probe-capped and fail-closed to `[]` on overflow), and `reconstructProjectDir` returns a
path **only when exactly one** exists — otherwise `null`. Discovery therefore probes a
checkout's Git remote only for an unambiguous reconstruction; any ambiguity falls back to
the conservative local identity and the Git probe is not even consulted. A lossy inverse
can never authorize a strong project identity (even when multiple candidates would share a
Git remote — the conservative policy is preferred). Private Memory is never bound or
restored to a different project via an ambiguous inverse.

**Forensic correction.** The prior report attributed the contaminated Machine F registry to
"a real `stack memory backup`." That is **retracted** — the exact live writer cannot be
proven from the recorded evidence. Tracing every production writer of `projects-local.json`
and `project-registry.json` shows only three: `cloudRecover` (recover), `adapter.backup()`
(a real backup's local step), and `mapProject` (`stack project map`). None of the commands
in the actual dogfood sequence (`stack project`, `memory scan`, `memory restore`
[+`--dry-run`], `memory backup --dry-run` [+`--verbose`/`--json`], `memory backup --help`,
`memory status`) writes either file — verified in code and locked by handler-level purity
tests. A real `stack memory backup` was not run and Cloud stayed at generation 3. The
`stack project` = 10 vs `memory status` = 9 divergence is expected and not proof of a
writer: `stack project` counts registry records (`registry.projects.length`), while
`memory status` counts distinct project-identity keys in the current manifest. A registry
can hold a record the current manifest no longer references (a stale Atlas record left from
an earlier resolution), so the two sources legitimately differ. The precise write sequence
that produced the extra record is not recoverable from the available evidence; the 15B.4
fix is prevention (cwd-independent, ambiguity-safe resolution), not repair. Machine F will
be discarded and recreated as F2 from generation 3.

### 15B.5 — recovery registry provenance (2026-09-29)

**Live F2 finding (facts).** The contaminated Machine F was deleted. A completely fresh
Machine F2 (fresh HOME, fresh STACK_HOME, fresh Atlas checkout seeded only with the Git
remote) authenticated and ran `stack memory recover --passkey`. With **no** native
restore, project map, or real backup, `stack project` showed **ten** logical projects
whose IDs (including the bogus `prj_ezj7hk…` local-Atlas duplicate and the Git-Atlas
`prj_xbb9zv…`) exactly matched the earlier contaminated Machine F, while `memory status`
showed 9 projects / 27 files. F2's `memory/manifests/project-registry.json` (and
`projects-local.json`) contained all ten records; `projects-local.json` had
`"bindings": []`.

**Central question.** How did `prj_ezj7hk…` — first seen during Machine F work — appear
in the registry reconstructed by a completely fresh F2 — when the latest generation was
believed to be 3 (a read-only Cloud inspection later showed it was **4**; see the
chronology closure below)?

**Answer (proven from source + reproduced synthetically).** The recovered **committed
Cloud generation's own payload** carries a portable registry snapshot (`registryB64`)
holding those exact records, and recovery decodes it faithfully. Evidence:

1. `stack memory recover --passkey` downloads only the committed generation's encrypted
   payload (`cloudRecover` → `backend.getPayload(meta.backupId)`), decrypts it locally,
   `restoreBundleToStore`s it, then `reconcileRegistryAfterRecover`. The browser bridge
   only produces/unwraps the MMK and seals it to the CLI; it never handles the
   bundle/registry and persists no `localStorage`/`sessionStorage`/IndexedDB/cookie state
   (audited). The registry never leaves the encrypted bundle.
2. `restoreBundleToStore` writes `project-registry.json` **only** from the bundle's
   `registryB64`; otherwise it writes nothing. `reconcileRegistryAfterRecover` consults
   **only** the recovered snapshot and the fresh local registry — no cwd, Git, Cloud,
   browser, account store, or other STACK_HOME. Into an empty fresh registry, a merge
   copies the snapshot's Project IDs **exactly**.
3. Project IDs are random (`mintProjectId` = 128-bit CSPRNG; never derived from
   path/Git/content/account/compat digest). So a genuinely registry-less bundle would
   lazy-mint **different** IDs on each fresh machine (test: two fresh recoveries diverge).
   F2 matching F exactly ⟹ the IDs were **copied from the bundle**, not re-derived.
4. Committed generation payloads are immutable: object keys are unique per random
   `backupId` (`mem/<userId>/<backupId>`), the domain backend rejects a duplicate
   `backupId`, and a later generation never alters an earlier generation's bytes (tests).
   `verifyPayload` checks downloaded bytes against the committed (immutable) SHA, so a
   silently-replaced object would fail recovery — F2's recovery succeeded, so the bytes
   are the committed bytes.

Therefore F2's ten records, the two Atlas records, and the 10-registry / 9-manifest split
were **baked into the committed generation's payload** and reproduced verbatim. The
10-vs-9 split is itself carried in the bundle: the snapshot holds 10 records (a stale
Git-Atlas record with no manifest items + the local-Atlas duplicate + 8 legacy) while the
manifest references 9 distinct identities across 27 files. This exact shape is reproduced
synthetically in `recovery-provenance.test.ts`.

**Root cause.** **Generation 4** was created by a **pre-15B.4** real `stack memory backup`
(Machine F, 2026-09-28) whose store already held the contaminated `project-registry.json`
(the cwd-dependent Git-resolution bug fixed in 15B.4, which minted the duplicate
local-Atlas project). That backup embedded the contaminated registry into an immutable
generation **before** the 15B.4 fix landed. 15B.4 prevents _new_ contamination but,
correctly, cannot alter an already-committed immutable generation. So every subsequent
recovery of the latest generation — contaminated F and fresh F2 alike — faithfully
reproduces it.

**Corrections to earlier narrative.** (a) The 15B.4 report's retracted "a real backup
wrote the bogus ID" is now **fully resolved**: a real Machine F `stack memory backup`
embedded the contamination into **generation 4** on 2026-09-28 (chronology closure below).
(b) F2 recovered the **latest** generation, which is **generation 4** — not generation 3.
Generation 3 predates Phase 15, does **not** carry a portable registry, and remains intact
and immutable. Generation 4 carries `registryB64` and was produced by Phase-15B code (the
`registryB64`/`registrySha256` bundle fields were introduced in `a65c5d0`).

**No new runtime defect in recovery.** Recovery reads only the committed payload; there is
no browser/dev-server/cross-STACK_HOME/account leakage; IDs are random; committed
generations are immutable. One **defense-in-depth hardening** was applied: the Supabase
backend now uploads generation payloads with `upsert: false` (was `true`), so a committed
object can never be overwritten even on an accidental same-`backupId` re-upload — aligning
it with the domain backend, which already rejects a duplicate `backupId`.

**Remediation (not in this phase).** The contamination lives in an immutable committed
generation and must be **superseded by a new clean backup** (a fresh, correctly-resolved
generation created by post-15B.4 code), never by mutating the existing generation. F2 is
preserved as evidence and will be discarded; a fresh machine will create the clean
generation. No automatic merge/repair of the contaminated IDs was added.

**Resolved (2026-09-29).** A read-only Cloud inspection has since established the full
generation chronology and removed the earlier uncertainty — see the chronology closure
immediately below.

### 15B.5 closure — live generation chronology (2026-09-29)

A read-only inspection of the account's Cloud database and storage (no payload
decryption, no recover/backup, F2 untouched) resolved the final uncertainty. **Five**
generations exist — the earlier assumption that "no generation 4 exists" was **false**:

| Gen | created_at (UTC)    | mode      | state     | bytes | parent |
| --- | ------------------- | --------- | --------- | ----- | ------ |
| 0   | 2026-09-26 11:30:00 | standard  | retired   | 1738  | —      |
| 1   | 2026-09-26 11:49:04 | protected | committed | 1766  | —      |
| 2   | 2026-09-26 12:41:14 | protected | committed | 1838  | —      |
| 3   | 2026-09-26 13:58:45 | protected | committed | 73126 | 2      |
| 4   | 2026-09-28 16:45:57 | protected | committed | 76442 | 3      |

Cross-referenced with the git chronology (`66942c1` 14B.5 on 2026-09-26; `a65c5d0` 15B on
2026-09-27; `153a6cc`/`8b7d96e` the 15B.4 fix on 2026-09-28 ~20:46/22:34 local):

- **Generation 3 conclusion.** Created 2026-09-26 by the real Protected **Phase‑14B**
  backup. It **predates** Phase 15 and therefore carries **no** portable project registry.
  Its storage object's created/updated timestamps are identical (2026-09-26 13:58:45) with
  no later update, and its size (73126) is unchanged — i.e. **not overwritten in place**.
  It remains the last known‑good historical generation.
- **Generation 4 conclusion.** Created 2026-09-28 16:45:57 UTC (~17:45 local), parent 3,
  Protected, committed, 76442 bytes, in its **own** storage object (separate key/version).
  It carries the Phase‑15B portable registry with the **10** contaminated records
  (duplicate local‑Atlas + Git‑Atlas + 8 legacy), a manifest of 9 identities / 27 files,
  and no portable machine bindings. It was created **before** the 15B.4 Git‑identity fix,
  which is why it embeds the cwd‑dependent duplicate‑Atlas contamination.
- **F2 recovery conclusion.** `stack memory recover --passkey` selects the **latest**
  generation, so fresh F2 recovered **generation 4** (not generation 3) and faithfully
  decoded its `registryB64` — which is exactly why the earlier Machine‑F random Project IDs
  reappeared on a completely fresh machine.
- **Machine F correlation.** The contaminated Machine F `project-registry.json` /
  `projects-local.json` last‑write time (2026-09-28 ~17:45:52 local) immediately precedes
  generation 4's object creation (~17:45:56) and DB commit (~17:45:57), matching the
  production transaction order (local backup/registry commit → encrypted object upload →
  Cloud generation commit). The user had been asked to run a real `stack memory backup`;
  the shell was then lost before its console output was captured, which is why the backup
  was mistakenly assumed not to have happened. The live database disproves that: **the
  backup completed and created generation 4.** (The terminal output itself was lost and is
  not reconstructed here.)
- **Immutability conclusion.** The live evidence supports generation isolation:
  generation 3's object was not later updated, and generation 4 uses a separate,
  newly‑created object. The e31ff5c hardening (Supabase upload `upsert: false`) is
  **retained** as defense‑in‑depth enforcing the immutable‑generation contract — kept even
  though in‑place overwrite was not the incident cause.

**Assumptions explicitly corrected.** The following earlier statements are wrong and are
corrected by this closure: that generation 3 carried the Phase‑15 portable registry; that
generation 3 was rewritten in place; that no generation 4 existed; that F2 recovered
generation 3; and that the exact committing event was unknowable. F2 recovered
**generation 4**, which a **pre‑15B.4 real Machine F backup** committed on 2026-09-28.

**Product requirement recorded (not implemented here).** F2 recovered the latest
generation automatically. Because generation 4 is logically contaminated while generation
3 is the last known‑good historical generation, users need a safe way to **inspect and
explicitly recover a previous immutable Memory generation** when the latest is unwanted.
Possible future UX (concepts only, not frozen): `stack memory generations` and/or
`stack memory recover --generation <n>`. This is recorded for the next design step; no CLI
syntax or behavior is implemented or committed in this closure. The contamination is still
remediated by **superseding it with a new clean backup** (a fresh generation 5 from
post‑15B.4 code), never by mutating an immutable generation.
