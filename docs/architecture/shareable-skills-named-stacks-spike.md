# Shareable Skills + Named Stacks — P10 Read-Only Architecture Spike

**Status:** investigation only. Zero code changes, zero migrations. This document and its
companion task report are the only artifacts this spike produced.

**Scope note on sourcing:** the task brief for this spike refers to a "correction brief §17
(questions), §18 (user flows), §19 (privacy/security checklist)". That correction brief's
numbered sections were not found anywhere in this repository (`.superpowers/sdd/`,
`docs/superpowers/plans/`) as a standalone file — only the plan file
`docs/superpowers/plans/2026-10-10-p9-shell-storytelling-and-p10-spike.md` references those
section numbers, without reproducing their contents. Rather than invent plausible-sounding
answers to an unseen question list, this document reconstructs the equivalent question set
from (a) the candidate model given directly in this task's assignment (MAIN / NAMED STACK /
PUBLIC STACK / INDIVIDUAL SHARED SKILL) and (b) the four user flows and privacy/security
checklist items that assignment explicitly enumerated. Every question below is answered
against the real source tree; where the real answer is genuinely unknown, it is marked as
such rather than guessed.

---

## 1. Current architecture findings

### 1.1 Local (CLI-side) state: one hardcoded environment, `main`

- `packages/core/src/state.ts:145` — `statePaths()` builds the on-disk environment directory
  as `path.join(stackHome, 'environments', 'main')`. The string `'main'` is a literal baked
  into the function, not a parameter. There is no `environments/<name>` concept locally.
- `packages/core/src/initialize.ts:122-168` (`initializeMainEnvironment`) hardcodes
  `name: 'main'` in the `EnvironmentManifest` it writes (line 154) and in the
  `MachineEnvironmentBaseline.environment` field (line 167), and its own duplicate-init guard
  error is literally `'main already exists. Use stack status to inspect it.'` (line 138).
- The CLI UI layer doubles down on this: `packages/cli/src/ui/cloud.ts` hardcodes the literal
  string `'main'` in rendered text and in the JSON payloads returned by `pushPlanJson` (line
  83: `environment: 'main'`) and `pullPlanJson` (line 180: `environment: 'main'`) — these are
  not derived from any variable, they are string literals.
- **Conclusion:** the CLI-local plane structurally assumes exactly one environment per
  machine today. Supporting a second local named environment would require parameterizing
  `statePaths()`, `initializeMainEnvironment`, and every CLI command/UI string that currently
  hardcodes `'main'` (`push.ts`/`pull.ts`'s call sites into `ui/cloud.ts`, `program.test.ts`
  fixtures, etc.) — a real (if mechanical) code change, not a data-model change.

### 1.2 Cloud (server) schema: already name-keyed per user, not `main`-specific

- `supabase/migrations/0001_stack_cloud.sql:45-52` — `public.environments` is:
  ```
  environment_id uuid primary key
  user_id uuid not null references auth.users(id)
  name text not null
  latest_version_id uuid
  created_at timestamptz
  unique (user_id, name)
  ```
  There is **no CHECK constraint, no default, and no app-level gate forcing `name = 'main'`**
  at the database layer. The `unique (user_id, name)` constraint is exactly the shape needed
  to support multiple named environments per account today.
- `public.environment_versions` (same file, lines 54-68) is already append-only/immutable
  (`forbid_version_update()` trigger) and keyed by `(environment_id, version_number)` — this
  versioning model is name-agnostic; it has no dependency on the environment being called
  `main`.
- `packages/cloud-server/src/repository.ts:216-230` — `getEnvironmentByName(userId, name)` and
  `commitEnvironmentVersion({ userId, name, ... })` are already generic over `name`.
  `packages/cloud-server/src/service.ts:475-511` (`getEnvironment`) and `:513-583`
  (`commitEnvironmentVersion`) take `name: string` as a parameter and never hardcode `'main'`
  — the only place `name` is pinned to `'main'` is the **caller** (the CLI, via
  `push.ts`/`pull.ts`, which always resolve the local single environment and always pass the
  literal `'main'` through to these already-generic service calls — confirmed by the `'main'`
  literals in `ui/cloud.ts` above, which render exactly what was pushed/pulled).
- **Conclusion:** the Cloud DB schema and service layer for `environments`/`environment_versions`
  **already structurally support multiple named environments per account with zero migration**.
  The constraint that there is only ever one, named `main`, lives entirely in CLI application
  code (`statePaths`, `initializeMainEnvironment`, command wiring), not in the database.

### 1.3 "Stack" already means something different from "environment" — and it's closer to the NAMED STACK concept than expected

- `packages/cli/src/commands/use.ts:24-25` — `stak use <stack>` is described as "Add a local
  or public (`@owner/name`) Stack to main". This is **not** an environment switch. A "Stack"
  in the current product is a reusable, named Skill-composition _layer_ (a manifest:
  `packages/spec/src/stack.ts:11-17`, `stackManifestSchema` — `name`, `description`, `extends`,
  `skills[]`) that gets resolved and merged into the single environment (`main`) as an
  `EnvironmentStackLayer` (`packages/spec/src/stack.ts:64-70`, carrying `id`, `stackId`,
  `name`, `versionHash`, and an optional `source` discriminating `local` vs. `public`
  (`environmentStackLayerSourceSchema`, lines 52-63)).
- The signed-in web product's own copy confirms this framing: `apps/web/app/stacks/page.tsx:84`
  — "A Stack is the Skills that make up your portable STAK environment." Today there is
  exactly one Stack-composition surface, and it **is** `main`; "Stack" and "the composition of
  `main`" are synonyms in the current UI, even though the underlying `EnvironmentStackLayer`
  model already represents a Stack as a distinct, named, versioned object layered into an
  environment, not the environment itself.
- **Conclusion:** the plan's candidate NAMED STACK concept (a reusable curated composition,
  not itself the machine-installed state) is not a new idea for this codebase — it already
  exists as `EnvironmentStackLayer`/`stackManifestSchema`/`ImportedStack`. What's missing is
  (a) the ability to apply a Stack layer to anything other than the single environment
  `main`, and (b) a private, un-published, named "collection of Stack layers" object a user
  could create, edit, and later apply/share independent of `main`.

### 1.4 Public Stack: already a fully separate, versioned, reference-only publication path

- `supabase/migrations/0002_public_stacks.sql` defines `public.public_stacks` (owner, slug,
  display name, description, `latest_version_id`, `unique(owner_user_id, slug)`) and
  `public.public_stack_versions` (immutable, `unique(stack_id, version_number)`, enforced
  immutable via `forbid_public_version_update()` trigger, lines 54-63). This is a complete,
  independent-of-`main` publication model: **owner-keyed, slug-addressed, versioned,
  immutable, world-readable** (RLS policies at lines 150-155 grant anonymous `select`).
- `packages/spec/src/public.ts:167-179` (`publicStackBundleSchema`) is the published payload:
  `stack: {name, description, versionHash}`, `requirements[]` (each
  `publicStackRequirementSchema`, line 156), `inheritedStackMetadata[]`, `digest`. Crucially,
  each requirement's `restoration` field is typed as `referenceRestorationSchema` **only**
  (`packages/spec/src/public.ts:4,162` imports and uses `referenceRestorationSchema`, not the
  full `restorationStrategySchema` union from `storage.ts:62-65` that also includes
  `snapshotRestorationSchema`). A Skill resolved via the `snapshot` strategy (i.e. with no
  portable Git source — local-only, unknown-source, ambiguous-source, modified-source,
  non-portable-source per `snapshotReasonSchema`, `storage.ts:5-11`) **cannot be
  type-constructed into a public bundle at all** — this is a structural, type-level
  guarantee, not just a runtime check, that private/local Skill content can never enter the
  public plane through this path.
- `packages/cloud-server/src/public-service.ts:120-129` additionally runs
  `inspectPublicSourceRemote` (from `packages/spec/src/public.ts:74-131`) over every
  requirement's `restoration.reference.remote` before publishing, rejecting: embedded
  credentials (username/password in the URL), `file:`/absolute-path/loopback remotes, and
  unsupported schemes. Allowed: `https://`, `ssh://`, `git://`, and bare `user@host:path`
  SCP-style remotes (lines 74-131).
- **Conclusion:** "Public Stack remains V0 reference-only, no private snapshots, immutable
  versions" is not a to-be-designed property — it is **already true today**, enforced at both
  the schema-type level and the service-validation level, for the one thing that can
  currently be published (a whole Stack bundle).

### 1.5 No standalone Skill object exists anywhere — public or private

- Searched `packages/cloud-server/src/product-service.ts` (1,329 lines) and
  `packages/cloud-server/src/public-service.ts` (304 lines, full read above): there is no
  table, repository method, or service function that publishes, stores, or fetches a single
  Skill independent of a Stack/Environment bundle.
- DB-level confirmation: `supabase/migrations/0005_product_read_models.sql` (P3 product read
  models) adds only `public.cloud_projects` (Project registry: opaque id, lifecycle, safe
  display name — explicitly "no filesystem path... no Memory content", lines 7-10). There is
  no `skills` table anywhere in `supabase/migrations/*.sql`. Skills only ever exist as JSON
  entries inside `environment_versions.bundle` (private plane) or `public_stack_versions.bundle`
  (public plane) — both `jsonb` columns (`0001_stack_cloud.sql:60`, `0002_public_stacks.sql:36`).
- **Conclusion:** Skills are not first-class rows in the Cloud schema today, in either plane.
  They are always embedded JSON inside a Stack/Environment bundle. There is no existing
  "publish one Skill" code path to extend — sharing a single Skill today would mean
  constructing a Stack bundle with exactly one requirement and publishing that (see §2).

### 1.6 P5a Git/source-reference identity model — reusable for Skill identity, not for sharing semantics

- `supabase/migrations/0006_skill_review_checks.sql` (P5a `skill_review_checks` table) is
  keyed `primary key (user_id, skill_id)` (line 69) — **strictly single-owner-scoped**. It
  stores source-check state (`no-update`/`update-available`/`cannot-check`/`check-failed`/
  `consumed`), a candidate revision/content-hash, and a bounded diff-file metadata list
  (path/kind/binary/sizes/hashes — explicitly never file text, never a path, never a
  credential; see the file's header comment, lines 8-14). It has RLS granting the owner
  read-only access and all writes go through the service role (lines 75-79) — there is no
  concept of this table, or anything derived from it, being visible to another account.
- The Git **identity primitives** this table and its surrounding code rely on — a Skill's
  `ReferenceRecord` (`remote`, `revision`, repo-relative `path`, `expectedContentHash`,
  optional tracked `ref`; `packages/spec/src/storage.ts:30-49`) and the public-safety
  predicates (`inspectPublicSourceRemote`, `isSafeDisplayUrl`) — are exactly the pieces that
  would need to be reused for single-Skill sharing, and they already exist independent of
  Stack publication (`public.ts` has no dependency on the Stack bundle shape for these
  functions; they operate on a bare remote string).
- What does **not** exist: any mechanism that takes `skill_review_checks` (a private cache of
  "is my local Skill stale against its source") and turns it into a publication. The
  provenance/identity model (remote + revision + content hash) is reusable; the private
  review-check table itself is not a sharing mechanism and was never designed to be one — it
  has no `public`/`owner_handle` columns, no immutability trigger, and is explicitly a
  "latest-only, replaced-on-next-check" cache (file header, lines 4-6), the opposite of the
  immutable-version semantics public sharing requires.
- **Conclusion:** individual-Skill sharing would reuse the _reference-identity primitives_
  (`ReferenceRecord`, `inspectPublicSourceRemote`) and the _existing public-Stack publish
  pipeline_ (§2 below), not the P5a review-check table itself.

---

## 2. Individual Skill-sharing feasibility

**Confidence: medium-high that no new table is required; medium that no code is required
beyond CLI/UI surface.**

The existing public-Stack bundle schema (`publicStackBundleSchema`,
`packages/spec/src/public.ts:167-179`) already allows a bundle with exactly one entry in
`requirements[]`. Nothing in `public-service.ts`'s `publishPublicStackVersion` (lines
107-211) or the DB function `commit_public_stack_version`
(`supabase/migrations/0002_public_stacks.sql:66-143`) requires more than one requirement — the
only size constraint is an upper bound (`MAX_REQUIREMENTS = 500`,
`public-service.ts:33`), not a lower one.

This means: **"publish a single Skill" is, today, representable as "publish a Stack whose
bundle has one requirement"** — with all the same guarantees (reference-only restoration
enforced by the type system, source-remote safety checks, immutable versions, owner/slug
addressing). No new Cloud table or migration is structurally required to get a shareable,
versioned, provenance-preserving single-Skill artifact.

What is genuinely missing (CLI/product surface, not schema):

- There is no `stak skill publish <skill>` (or equivalent) command. `packages/cli/src/commands/skill.ts`
  only has `update`, `pause`, `resume`, `check` (lines 133-183) — no publish verb. `publish.ts`
  (`registerPublishCommand`, line 29) only accepts `<stack>`.
- There is no distinct "Skill" identity on the public read side —
  `getPublicStackResponseSchema`/`getPublicStackVersionResponseSchema`
  (`packages/spec/src/public.ts:192-211`) return a Stack-shaped object even when it
  conceptually holds one Skill. A user sharing "my Skill" would, today, be sharing something
  the recipient's CLI sees and names as a Stack (`@owner/skill-name` resolving to a one-item
  Stack bundle) — which may be acceptable product framing (P10 decision) but is not the same
  UX as a first-class "Skill" share link/object.
- Whether the product wants a dedicated `public_skills`/`public_skill_versions` table (mirroring
  `public_stacks`/`public_stack_versions` 1:1, but addressed as `@owner/skill-slug` with its own
  namespace separate from Stack slugs) instead of overloading one-item Stacks is an **open
  product decision**, not an architecture requirement — the one-item-Stack approach works
  today with zero schema change; a first-class Skill table would be a new, but mechanically
  simple, additive migration (see §6).
- **Unknown, needs further investigation:** whether `stak use <stack>` (and the underlying
  `use.ts`/`core` resolution path) can correctly treat a one-requirement public Stack
  identically to a multi-requirement one end-to-end (I read the command-registration code and
  the schema, not the full resolution/merge implementation in `packages/core/src/stack-composition.ts`
  for this specific one-item edge case) — worth a focused unit-test check before committing to
  this approach in a real P10 plan.

---

## 3. Named-Stack feasibility

**Confidence: medium.** Two distinct things are being asked for under "named Stacks," and
they have different feasibility:

**(a) A _local, un-published_ Stack manifest the user authors and names, used to compose
`main`.** This already fully exists: `stackManifestSchema` (`packages/spec/src/stack.ts:11-17`)
is a named, described, inheritable (`extends`), Skill-listing manifest; `stak use <stack>`
already consumes a "local or public (`@owner/name`) Stack" (`use.ts:25`). Nothing new is
needed here — a user can already create as many distinct local Stack manifests as they like
and layer any of them into `main` via `stak use`.

**(b) A second, independently-selectable, machine-applicable environment that is not `main`**
(e.g., switching between a "frontend" environment and a "mobile" environment the way `main`
works today, each with its own resolved lock/projection). This is the part that does **not**
exist today and is gated by §1.1's finding: the CLI-local plane (`statePaths`,
`initializeMainEnvironment`) hardcodes a single `environments/main` directory. The **Cloud**
side (§1.2) already supports this with zero migration (`environments` is `unique(user_id,
name)` already); the **CLI-local** side does not, and would need real code changes:
parameterizing `statePaths()` to accept an environment name, extending
`initializeMainEnvironment` (or adding a sibling `initializeNamedEnvironment`) to create
`environments/<name>` directories, and auditing every CLI command that currently assumes
there is exactly one environment directory (`push.ts`, `pull.ts`, `status.ts`, `run.ts`,
`diff.ts`, `skill.ts` — not individually re-read in this pass; flagged as follow-up scope, not
confirmed exhaustively).

So: if "named Stack" means (a) — a reusable, selectable composition recipe applied into
`main` — **this is already supported today, zero new code, zero migration.** If it means (b)
— a second real environment alongside `main` that gets its own machine-installed state — **this
requires real CLI code changes (not a migration)**, because the Cloud schema is already
name-generic but the CLI's on-disk/initialization layer is not.

Per the candidate model in this task's brief ("NAMED STACK ... NOT machine-installed state"),
the brief's own definition points at (a), not (b) — a named Stack is explicitly _not_
machine-installed state, it's a composition recipe. Under that reading, **named Stacks (as
specified by the brief) are feasible today, as `EnvironmentStackLayer`/`stackManifestSchema`
objects, with no migration** — the open work is a _private, named, listable collection of
these the user manages outside of `main`'s current layer list_ (today, Stack layers only
exist as entries already merged into `main`'s manifest, `environmentManifestSchema.stacks:
environmentStackLayerSchema[]`, `environment.ts:44`; there's no account-level registry of
"Stacks I've created but haven't necessarily applied to `main`" — see §6 for the minimal
schema this would need).

---

## 4. Relationship between `main` and named Stacks

- `main` is the one real environment: a user's actual, machine-synced, lockfile-backed desired
  state (`EnvironmentManifest`/`EnvironmentLock`, `environment.ts:40-70`), always singular
  today (§1.1).
- A (named) Stack is a composition recipe — a named, versioned set of required/optional Skill
  requirements (`StackManifest`/`ImportedStackVersion`, `stack.ts:11-45`) that gets resolved
  and merged as a layer into an environment (`EnvironmentStackLayer`, `stack.ts:64-70`). Today
  the only environment a Stack layer can be merged into is `main`.
- Under the brief's model (NAMED STACK ≠ machine-installed state), the clean mental model is:
  **`main` is state; a Stack is a recipe.** A user could, in principle, maintain several named
  Stacks (frontend/mobile/research/release) without any of them ever being "applied" — they'd
  just be saved compositions, previewable (`stak use --dry-run` already supports previewing a
  Stack's resolution without applying it, `use.ts:26,36-53`) and eventually one or more layered
  into `main` when the user actually wants that composition active on a machine.
- This reframes the P10 feature primarily as: "let a user save/name/list/edit a Stack
  manifest and its account-side published history, independent of whether it's currently
  layered into `main`" — which is much closer to extending the existing public-Stack
  publish/version model with a **private** (unpublished) tier than it is to building
  multi-environment support.

---

## 5. Public/reference-only implications

Already true today, not something P10 needs to newly enforce (§1.4):

- Public Stack bundles can only contain `reference`-strategy requirements
  (type-enforced, `public.ts:162` using `referenceRestorationSchema` not the full union).
- Publishing performs `inspectPublicSourceRemote` on every requirement's Git remote
  (`public-service.ts:120-129`), rejecting credentials, loopback/file/absolute-path remotes.
- Versions are immutable once committed (`forbid_public_version_update()` trigger,
  `0002_public_stacks.sql:54-63`); publishing a changed Stack always creates a new version
  number via `commit_public_stack_version`, never an in-place edit.
- RLS grants anonymous read on `public_handles`/`public_stacks`/`public_stack_versions`
  (`0002_public_stacks.sql:146-155`) — writes are service-role only (owner identity is always
  derived server-side from the authenticated CLI token, per the migration's own header
  comment, lines 2-4 — never client-asserted).

A hypothetical **private-named-Stack publish** (sharing with one specific person rather than
the world, per the brief's "share with another person" framing for Skills, and implicitly
relevant to Stacks too) is **not supported by this model at all** today — `public_stacks` has
no access-control column (no allow-list, no "unlisted" visibility tier); everything published
through this path is world-readable by slug the moment it's published. Direct-share-with-one-
person is a genuinely new capability, not a variant of existing public publish (see §6).

---

## 6. CLI implications

- `stak use <stack>` already describes the right verb for _applying_ a (local or public)
  Stack composition into `main` (`use.ts:24-25`) — this verb would likely stay the same under
  named Stacks, since applying a named Stack into `main` is exactly what it already does when
  given a Stack name.
- `stak publish <stack>` (`publish.ts:29`) already describes the right verb for _publishing_ a
  Stack — this is reusable for publishing a named Stack unchanged, and (per §2) could also be
  the literal mechanism behind "share a Skill" if the product accepts one-item-Stack framing.
- Missing CLI surface for the brief's four flows (see §7): a verb to _create/name_ a Stack
  without immediately using/publishing it (today a Stack only exists as a manifest file the
  user hand-authors — there's no `stak stack create <name>` scaffolding command found in
  `packages/cli/src/commands/*.ts`), a verb to _list_ a user's own named Stacks (local or
  account-side), and a verb to _share with one person_ (as opposed to publish-to-everyone).
- `stak skill` (`skill.ts:133-183`) has no `publish`/`share` subcommand at all today (§1.6,
  §2) — this would be new CLI surface regardless of whether the backend reuses the Stack
  publish pipeline.

---

## 7. The four user flows — supported today vs. new work

### Flow A: Create a named Stack

1. Author a Stack manifest (name/description/skills) — **supported today** via
   `stackManifestSchema` (`stack.ts:11-17`); the user writes/edits the manifest file by hand
   or via an existing scaffolding path not found in this pass (no `stak stack create` command
   exists — **new CLI work** to make this a guided/ergonomic step rather than hand-authoring
   YAML).
2. Save/name it privately (without publishing) — **supported today** as a local file; there is
   no account-side "my private Stacks" registry (no DB table) — **new schema work** if the
   product wants these to sync/survive across machines before the user chooses to publish or
   apply them (see proposal in §9).
3. Preview its resolution — **supported today**, `stak use <stack> --dry-run`
   (`use.ts:26,36-53`).

### Flow B: Edit a named Stack

1. Edit the local manifest file directly — **supported today** (plain file edit); no Stack
   "version history" exists for a _local, unpublished_ Stack today (`ImportedStackVersion`
   versioning, `stack.ts:35-44`, only materializes once a Stack is resolved/imported into an
   environment or published).
2. Re-apply the edited Stack into `main` — **supported today** via `stak use` again (re-running
   `use` with a changed local manifest re-resolves it; `use.ts`'s `applyUse` path).
3. See a diff between the Stack's old and new composition before re-applying — **unknown,
   needs further investigation**: `use.ts`'s dry-run shows the _resolved_ result
   (`proposal.resolved`/`proposal.summary`, lines 44-47) but I did not confirm whether this
   is rendered as a diff against the Stack's previously-applied state or only as the absolute
   resulting composition. Worth checking `packages/core/src/stack-composition.ts` directly in
   a follow-up before committing this to a plan.

### Flow C: Share a (named) Stack

1. Publish to everyone via slug — **fully supported today**, unchanged: `stak publish <stack>`
   → `publishPublicStackVersion` → `public_stacks`/`public_stack_versions`
   (§1.4, §5).
2. Share with exactly one other person (not the whole world) — **not supported today in any
   form.** `public_stacks` has no access-control/visibility column; the only sharing primitive
   is "published and world-readable by slug" or "not published, local-only." A targeted-share
   capability (grant one other handle read access to an unpublished or privately-published
   Stack) is **new schema and new service work** (see §9).

### Flow D: Share a Skill

1. Wrap it as a one-requirement Stack bundle and run it through the existing public-Stack
   publish pipeline — **mechanically supported today with zero schema change** (§2), pending
   confirmation of the one-item resolution edge case flagged above and pending new CLI/product
   surface (`stak skill publish`, or framing it explicitly through `stak publish` on a
   synthesized single-Skill Stack).
2. Present it to the recipient as "a Skill" rather than "a Stack with one item" — **new
   product/UI work regardless of backend approach** (distinct public read-model shape,
   `packages/spec/src/public.ts` would need a Skill-flavored response type even if it's served
   from the same bundle data).
3. Share with exactly one person rather than the world — same gap as Flow C step 2: **not
   supported today, new schema/service work.**

---

## 8. Privacy/security model — findings against the real codebase

- **Local-Skill leakage risk.** Structurally guarded today: `publicStackRequirementSchema`'s
  `restoration` field is typed `referenceRestorationSchema` only (`public.ts:156-166`), so a
  `snapshot`-strategy Skill (local/unknown-source/ambiguous-source/modified-source/
  non-portable-source, `storage.ts:5-11`) cannot be constructed into a publishable bundle —
  this is enforced by the type system at the boundary, not merely by a runtime check one could
  forget to call. The same guarantee would need to extend to any new single-Skill-publish path
  (§2) — straightforward to inherit if it's built on the same bundle type, a new risk if a
  separate "publish one Skill" payload type is introduced that doesn't reuse this constraint.
- **Source-credential leakage.** Guarded by `inspectPublicSourceRemote`
  (`public.ts:74-131`), called at publish time (`public-service.ts:122-129`): rejects any
  `https://`/`ssh://` remote with an embedded username/password, and the function's own
  comment notes it deliberately never echoes the raw remote back in the rejection reason "to
  avoid leaking embedded credential material" (`public.ts:71-73`).
- **Absolute-path leakage.** `referenceRecordSchema.path` is validated to reject absolute
  paths (`/...`, `C:\...`) and `..` traversal, requiring a repository-relative path
  (`storage.ts:33-42`). `inspectPublicSourceRemote` separately rejects `file:`/drive-letter/
  leading-`/` remotes outright (`public.ts:80-87`). Machine/project identity is similarly
  guarded elsewhere in the system (`CloudProjectRecord`/`cloud_projects` explicitly carries no
  path, per its own migration header, `0005_product_read_models.sql:7-10`) — consistent
  project-wide discipline, not a one-off.
- **Private-Git-repository behavior.** Only the remote _URL_ is published (as part of a
  `ReferenceRecord`), never repository content beyond what the CLI already read locally to
  compute `expectedContentHash`. A private repository's remote URL itself (e.g. an
  organization/path structure on a private host) is not content-sensitive the way credentials
  or file text are, but it **is** information the repository owner may not want exposed
  publicly (e.g., revealing the existence/name of an internal repo) — `inspectPublicSourceRemote`
  does not and structurally cannot know whether a given remote is "private" vs. "public" (that
  requires an authenticated fetch, which this function deliberately does not perform). This is
  a genuine, not-fully-closed privacy gap worth flagging for P10: **the system can prove a
  remote carries no embedded credentials and isn't a local path, but cannot prove the remote
  isn't itself sensitive information the user didn't intend to disclose.** Recommend a P10
  product decision (not an engineering fix) — e.g., require explicit per-Skill/per-Stack
  publish confirmation that shows the exact remote URL that will become public.
- **Content/snapshot boundaries.** Confirmed structurally separate storage: private
  `snapshots` table (`0001_stack_cloud.sql:77-84`, `primary key (user_id, content_hash)`,
  owner-only RLS) vs. public Stack bundles (reference-only, no snapshot data type-permitted in
  the public schema at all, per the first bullet above). There is no shared code path that
  could accidentally promote a private snapshot row into a public bundle — they are different
  tables with different schemas, and the public bundle type cannot represent a snapshot.
- **Malicious-Skill review surface.** The P5a skill-review-check mechanism
  (`skill_review_checks`, §1.6) exists but is **owner-scoped only** — it tells a user whether
  _their own_ installed Skill drifted from its approved source, it is not a mechanism for
  reviewing someone else's shared Skill before accepting it. Today, consuming a public Stack
  (`stak use @owner/slug`) resolves and merges its requirements with no distinct "review this
  incoming Skill's diff before trusting it" step found in `use.ts` — the dry-run shows the
  resolved composition, not a security-review-flavored diff of a _new, unfamiliar_ Skill's
  actual script/instruction content. **Unknown, needs further investigation:** whether
  `packages/core/src/stack-composition.ts`'s resolution surfaces enough for a user to inspect
  an incoming public Skill's real content before it's merged, or whether that inspection only
  happens later via the (currently owner-private) P5a review-artifact mechanism. This is the
  single most important open question for Skill-sharing safety and deserves a dedicated,
  code-level follow-up before any P10 implementation.
- **Public update/version semantics.** Confirmed immutable-version, append-only, "publish
  creates a new version number, never edits in place" (§1.4/§5). Already correct for the
  stated V0 reference-only model; no gap found.
- **Deletion/unpublish semantics.** Searched `public-service.ts` and the migration files: there
  is **no delete/unpublish operation** for a published public Stack (or, by extension, a
  single-Skill share built the same way) anywhere in the current code. A user cannot retract a
  published Stack version today. This is a real product gap for P10 to decide on deliberately
  (right-to-delete / "I published this by mistake" / revoked-collaborator scenarios) — not an
  oversight in this spike, but a genuine unresolved capability.
- **Ownership.** Consistently server-derived, never client-asserted: `owner_user_id` always
  comes from the authenticated `user.userId` in `publishPublicStackVersion`
  (`public-service.ts:107-211`), and the DB function takes `p_owner_user_id` as a parameter the
  service always supplies from the authenticated session, never from client input
  (migration header comment, `0002_public_stacks.sql:2-4`, reiterated in code).
- **Identifier stability.** `stackId`/`versionId` are server-generated UUIDs
  (`ctx.newId()`, `public-service.ts:193`), stable once created; the human-facing identifier
  is `@owner_handle/slug`, and `owner_handle` itself is derived once and reserved
  (`resolveHandle`, `public-service.ts:70-99`) with a uniqueness check
  (`findHandleOwner`/`reserveHandle`) preventing collision. A handle, once resolved for a user,
  is reused on subsequent publishes (`getHandleForUser` checked first, line 71) — it does not
  silently change. **Unknown, needs further investigation:** what happens to already-shared
  links if a user's `githubUsername` (the source of the derived handle, line 74) changes on
  GitHub — I did not find a handle-rename/re-derivation path in this pass, so whether existing
  `@owner/slug` links stay stable forever or could break on a profile change is unconfirmed.

---

## 9. Migration / schema requirement — proposal only, requires separate explicit approval

No migration is required for: (a) individual Skill sharing via one-item public Stack bundles
(§2), or (b) "named Stack" in the brief's sense of an unpublished local composition recipe
applied to `main` (§3a) — both work with the schema that exists today.

A migration **would** be required only if P10 decides to build either of these, which this
spike explicitly does not implement and flags for separate approval:

**(i) A private, account-synced registry of named Stacks a user has authored, independent of
publishing them and independent of `main`'s current layer list.** Minimal proposed shape
(prose, not DDL):

- A new table, conceptually `user_stacks`: one row per (user, stack name) the user has saved —
  `user_id`, a server-generated `stack_id`, `name`, `latest_version_id` (nullable),
  `created_at` — directly mirroring the existing `environments` table shape
  (`0001_stack_cloud.sql:45-52`) but for Stack-recipe objects instead of environment state, with
  the same `unique(user_id, name)` constraint.
- A new table, conceptually `user_stack_versions`: immutable version history of the above,
  mirroring `environment_versions` (`0001_stack_cloud.sql:54-68`) — `version_id`, `stack_id`,
  `user_id`, `version_number`, `digest`, `bundle` (the existing `StackManifest`/
  `ImportedStackVersion` shape from `packages/spec/src/stack.ts`), `created_at`, with the same
  append-only-via-trigger pattern as `environment_versions`/`public_stack_versions`.
- This is almost a structural copy of the existing `environments`/`environment_versions` pair,
  which is good evidence it's low-risk, but it is still a new migration and needs explicit
  approval before being written.

**(ii) A targeted ("share with one person," not world-publish) visibility tier**, needed for
both Flow C step 2 and Flow D step 3. Minimal proposed shape:

- A new table, conceptually `stack_shares` (or `skill_shares` if Skills get their own object
  per §2's open decision): `share_id`, `stack_id` (or `skill_id`)/`version_id` being shared,
  `owner_user_id`, `shared_with_user_id` (or `shared_with_handle` if sharing-by-handle before
  the recipient has an account is desired — a separate product decision), `created_at`,
  `revoked_at` (nullable, to support §8's flagged missing unpublish/revoke capability for this
  tier specifically). RLS would grant `select` to rows where
  `auth.uid() in (owner_user_id, shared_with_user_id)`, analogous to the owner-only pattern
  already used for `environments`/`skill_review_checks`.
- This is new, not a variant of anything existing — `public_stacks` has no access-control
  column to extend, and bolting one on would blur "world-public, slug-addressed, immutable
  forever" (today's model) with "visible to exactly one grantee, revocable" (the new need),
  which argues for a separate table rather than a column added to `public_stacks`.

Both proposals are deliberately modeled closely on existing, already-shipped table shapes
(`environments`/`environment_versions`, `public_stacks`/`public_stack_versions`,
`skill_review_checks`'s RLS pattern) specifically to minimize new risk surface. **Neither is
approved by this document. Both require a separate, explicit implementation plan and review
before any `.sql` migration is written.**

---

## 10. Recommended P10 scope (this spike's recommendation, not a decision)

Given the findings above, the lowest-risk, highest-leverage slice of this feature is:

1. Ship individual-Skill sharing first, as a one-requirement public Stack bundle under the
   existing pipeline (§2) — zero migration, mostly CLI/UX work (`stak skill publish`, a
   Skill-flavored public read-model response), plus closing the one open question about the
   one-item resolution edge case and the malicious-Skill review-surface gap (§8) before
   shipping.
2. Defer "named Stacks beyond `main`" in the multi-environment sense (§1.1/§3b) — it requires
   real CLI-local code changes with no schema payoff, and the brief's own definition of NAMED
   STACK ("NOT machine-installed state") doesn't actually need it; a private
   `user_stacks`/`user_stack_versions` pair (§9i) delivers the brief's named-Stack concept
   without touching the single-environment assumption at all.
3. Treat "share with exactly one person" (both Stack and Skill) as its own, later increment —
   it is the one capability with no existing analog anywhere in the current schema (§9ii), and
   it is the one place the current "public = world-readable by slug" model would need to
   coexist with a genuinely different, revocable, two-party visibility model.
4. Before committing to any of the above as a real plan, resolve this spike's two flagged
   "unknown, needs further investigation" items: (a) the one-item Stack resolution edge case
   in `stack-composition.ts`, and (b) whether an incoming public Skill's actual content is
   inspectable by the consuming user before merge, independent of the owner-private P5a
   review-check mechanism.

## 11. Open product decisions

- Does a shared Skill get its own first-class public object/table (`public_skills`), or does
  it permanently live as "a one-item Stack, presented as a Skill in the UI"? (§2)
- Is "share with exactly one person" delivered via account-to-account grants (requiring the
  recipient to have a STAK account, per the proposed `shared_with_user_id` column) or via a
  secret/obscure link anyone with the link can open (a materially different security model,
  not analyzed in depth here since the brief's framing — "share with another person" —
  reads as account-to-account but doesn't say so explicitly)?
- What happens to a Stack/Skill already shared or published when the owner wants to retract it
  — is "revoke" (hide from new access, keep existing grants' history) or "delete" (also
  invalidate anything already resolved/cached by a recipient) the intended semantics? (§8,
  deletion/unpublish gap)
- Should named Stacks (§9i) be able to be promoted straight to a public Stack (reusing the same
  version lineage/`versionHash`), or are "private named Stack" and "published public Stack"
  intentionally disconnected objects with no shared version history? This affects whether
  `user_stack_versions` and `public_stack_versions` should share a `versionHash`/digest lineage
  or be treated as entirely separate artifacts that happen to look similar.
- Is the handle-stability question (§8, end) acceptable as "unknown" for V0, or does it need
  resolving before any public sharing ships at all, given that a broken `@owner/slug` link
  would silently 404 a previously-shared resource?
