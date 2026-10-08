# Skill Review Artifact — Architecture Spike

Status: **ACCEPTED, frozen into `docs/0.1.0-contract.md` §5a (P5a).** The recommendation in §16 was
approved as-is; see the contract for the binding, product-facing semantics. This document remains the
design rationale and the detailed field-level/API-level proposal; where it conflicts with §5a, the
contract wins. Two refinements made at freeze time, not fully spelled out in the original spike:

- **`artifactPayloadHash`** is a distinct identity from `candidateContentHash`: `candidateContentHash`
  hashes the full candidate Skill tree and is produced by the CLI only (Cloud cannot recompute it, per
  §2 of the frozen trust model); `artifactPayloadHash` hashes the bounded review payload Cloud actually
  holds, and Cloud **can** and does verify this one, since it possesses the whole payload. The two are
  never conflated.
- **Approval is by `reviewArtifactId`**, not by the browser re-submitting `candidateRevision`/
  `candidateContentHash`. The server loads its own stored artifact and approves the candidate identity
  recorded inside it — removing any possibility of the browser mixing up or spoofing those two fields.

Originally written in response to a
P5 implementation blocker: the Skills Update Review / Approve flow cannot be built truthfully without
a candidate content hash and a real diff, and Cloud-side Git materialization was ruled out as the
wrong default. This document proposes the alternative architecture, per the brief's 18-point ask.

## 0. Audit: what already exists and is reused unchanged

| Primitive                                | File                                                                                                                                                      | Reused as                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exact-ref Git identity resolution        | `resolveSkillSourceLatest`, `gitLsRemoteRef` (`packages/core/src/skill-source.ts`)                                                                        | Source-check comparison, unchanged                                                                                                                                                         |
| Public-stack version identity resolution | `resolvePublicStackSourceLatest` (same file)                                                                                                              | Source-check comparison, unchanged                                                                                                                                                         |
| Pure tree diff                           | `diffSkillTrees` (same file)                                                                                                                              | Diff computation, unchanged — now actually called                                                                                                                                          |
| Tree hashing / path safety               | `enumerateSkillTree`, `hashSkillTreeEntries`, `validateTreePath` (`packages/shared/src/tree.ts`)                                                          | Candidate-tree hashing on the CLI, unchanged                                                                                                                                               |
| Exact-revision materialization template  | `restoreReference` (`packages/core/src/git-reference.ts`)                                                                                                 | Pattern reused for a new CLI-side "fetch candidate at exact revision" path — same shallow-fetch, same `assertPathWithin`, same hash-then-ingest shape, done **locally**, never server-side |
| Bounded content-addressed upload         | `blobStore.put(userId, contentHash, bytes)` ticket flow (`packages/cloud-server/src/service.ts:573-615`), `maxSnapshotBytes` (`service.ts:56,94,113-114`) | The exact precedent the review-artifact upload reuses — Cloud already accepts a bounded, content-addressed blob from an authenticated CLI session for Memory; nothing new there            |
| CLI command surface                      | `packages/cli/src/commands/{skill,status,scan,push,publish}.ts`                                                                                           | Vocabulary audited for Step 2 below                                                                                                                                                        |

Nothing here needs reinventing. The gap is entirely in **wiring**, not in missing pure logic.

## 1. Why server-side Git materialization is the wrong default

Confirmed by direct inspection, not assumption:

- `apps/web/lib/cloud-service.ts` never passes `checkSkillSource` to `createCloudService` — **`checkSkillSource` is optional and absent in the real deployed app today**. Every Skill currently reports `updateStatus: 'cannot-check'` in production, regardless of P5. This is a pre-existing P3 gap, not something P5 introduced.
- `PortableLockedSkill` (the Cloud-side Skill record) carries only `contentHash` + a `restoration` reference (remote/path/revision) — **never file bytes**. This mirrors Memory's privacy architecture: Cloud is a control plane, not a content store, by design.
- To materialize _either_ the candidate or the approved tree server-side for a diff, the Next.js process would need to newly spawn `git` and fetch arbitrary, user-configured third-party remotes over the network from the production web server. That is a new operational capability, not a reuse of existing code, and it introduces:
  - SSRF-shaped risk (the server fetching attacker-influenced URLs — a Skill's `restoration.reference.remote` is user-supplied data)
  - Resource/DoS exposure (unbounded clone size/time, one server process doing this per-request)
  - A runtime dependency (a `git` binary + child-process spawning) the Next.js deployment target may not provide or permit
  - No private-remote credential story — Cloud has never held and should never hold the user's Git auth

None of these are "add a few lines" problems; they are new trust-boundary decisions. The CLI, by contrast, already runs on the user's machine with the user's own Git credentials, already does exactly this kind of shallow fetch (`restoreReference`), and already has a precedent-setting bounded upload path (Memory's blob flow). Moving materialization there costs nothing new and adds nothing new to Cloud's trust boundary.

## 2. Proposed end-to-end architecture

```
 LOCAL CLI (source-resolution + materialization plane)
   stak skill check [<skill>]
     1. resolve tracked ref -> exact candidate revision (existing resolveSkillSourceLatest)
     2. if different from approved: shallow-fetch candidate at that exact revision (existing
        restoreReference-style fetch, LOCAL ONLY, user's own git auth)
     3. hash candidate tree -> candidateContentHash (existing hashSkillTreeEntries)
     4. shallow-fetch the APPROVED revision too (same remote, approved revision — this is
        also exact/immutable, so it's re-fetchable without ever touching a Store)
     5. diff(approvedTree, candidateTree) -> added/modified/removed (existing diffSkillTrees)
     6. bound the artifact: only diff-relevant file bytes, size-capped (see §4)
     7. upload ONE immutable review artifact to Cloud (reuses the existing bounded
        content-addressed blob-ticket flow)

 CLOUD (control plane + immutable review-artifact store)
   - stores artifact metadata (DB row) + bounded content (blob store), keyed by
     (skillId, candidateContentHash) — never re-fetches anything itself
   - Skills read model reports the LATEST artifact's result as "source status, as of the
     last `stak skill check`" — never an independent live check
   - Approve validates against the artifact's own recorded identity, not a re-derived one

 WEB (inspection / approval plane)
   - renders the artifact's diff/files/capabilities exactly as uploaded
   - Approve submits the artifact's own id/hash back to Cloud; Cloud verifies and commits
   - never fetches, diffs, or executes anything itself
```

This is the "LOCAL = resolution, CLOUD = control, WEB = inspection" split the brief asked to explore, and it fits the existing P1/P2/P3 division of responsibility (CLI does filesystem/Git work; Cloud is an authenticated, privacy-bounded store; Web only renders Cloud's read models) without inventing a 4th actor.

## 3. Review artifact concept

```ts
type SkillReviewArtifact = {
  entryId: string; // stable skill_... id — never a display name
  approvedContentHash: string; // what STAK had approved when this check ran
  source: {
    kind: 'git' | 'public-stack'; // Local/dirty/ambiguous/unreachable never produce an artifact
    safeLabel: string; // same sanitized label already used elsewhere — never a path
    trackedRef?: string;
  };
  candidate: {
    revision: string; // exact git commit / public version id
    contentHash: string; // sha256:<64hex> — real, not a revision string
  };
  checkedAt: string; // when the LOCAL check ran — Cloud never claims "live"
  diff: {
    files: { relativePath: string; kind: 'added' | 'modified' | 'removed' }[];
  };
  content: {
    // ONLY the files diff says changed, capped — never the whole tree, never unrelated files
    files: { relativePath: string; byteSize: number; blobRef: string }[];
  };
  restoration: ReferenceRecord; // already-existing type — what local reconciliation needs
};
```

Explicitly excluded, by construction: absolute/home-relative paths, Git credentials, auth tokens, env
secrets, any file outside the Skill's declared subtree, any local-machine metadata beyond what
`restoration` already carries today (which is already Cloud-safe — it's the same reference shape
`PortableLockedSkill.restoration` already uses).

This is new **data**, but zero new **semantics**: every field is either already-existing (contentHash,
restoration, safe labels) or a direct, typed product of already-existing pure functions
(`diffSkillTrees`'s output, `hashSkillTreeEntries`'s output).

## 4. CLI trigger

Audited existing vocabulary (`stak {init, login, logout, memory, open, project, publish, pull, push,
remove, run, scan, skill, status, try, use, whoami}`):

- `stak status` already means "local readiness + the explicit check-in" (per the P1 contract) — it is
  silent/offline-safe by design. Folding a network fetch of arbitrary third-party remotes into it would
  make a previously-safe, frequently-run command unexpectedly do new network I/O. Rejected.
- `stak scan` means "find agents and skills **on this machine**" — filesystem discovery, not a network
  operation. Wrong semantic fit. Rejected.
- **`stak skill check [<skill>]`** (your stated preference) fits the existing `stak skill {update,
pause, resume}` subcommand family exactly, is honest that it contacts remotes (symmetry with `stak
login`/`stak memory backup` already being the explicit, user-initiated network actions in this CLI),
  and doesn't change the behavior of anything that already exists. **Recommended.**
- No scope argument runs it for every checkable Skill; a scope argument checks one. Same selector
  resolution (`resolveSkillSelector`) `skill update`/`pause`/`resume` already use — no new ambiguity
  rules needed.

Output: prints per-skill result (no-update / update-available / cannot-check-\<reason\>), and on
"update-available" for a checkable source, produces and uploads the artifact. No daemon, no
background timer — exactly one artifact per invocation per changed Skill.

## 5. Cloud data boundary

- **DB row**: yes — one row per artifact (`skill_review_artifacts` or similar), holding everything in
  §3 except file bytes: entryId, approvedContentHash, source fields, candidate revision+hash,
  checkedAt, the diff's file list (paths + kind only — small, bounded by file count).
- **Object storage**: yes, for the bounded file content — reusing the **existing** `blobStore` content-
  addressed ticket flow Memory already uses, keyed by `(userId, candidateContentHash)`. No new storage
  subsystem.
- **Both** — small structured facts in Postgres, bounded bytes in the blob store. Exactly Memory's
  existing split.
- **Max payload size**: propose a small, Skill-appropriate cap — e.g. 2 MiB total content and 200
  files, both far below Memory's existing 200 MiB `maxSnapshotBytes` default (Skills are instruction
  text, not project data). Exact numbers are a product call, not an architecture one; both are
  config-driven like `maxSnapshotBytes` already is.
- **Retention**: **one latest artifact per Skill**, not history. A new `stak skill check` for the same
  Skill replaces the prior artifact (and its blob content) — review artifacts are a _working_ fact
  ("here's the last thing a CLI found"), not an audit trail. (The Skill's actual approved-version
  _history_ already exists and is untouched — this is unrelated to that.)
- **Invalidation**: an artifact is invalidated (deleted/ignored) the moment `approvedContentHash`
  changes under it (i.e., `approveSkillVersion` succeeds) — it described a source-vs-then-approved
  delta that no longer applies. Simplest rule: delete the artifact as part of the same transaction that
  commits the approval.

## 6. Privacy consequence — stated explicitly, as required

**Today, no Skill file content ever reaches Cloud.** This proposal changes that: a review artifact
necessarily uploads some Skill file bytes so the browser can show a real diff. This is a genuine,
narrow exception to the current "Cloud never holds Skill content" rule, not a hidden side effect of
convenience.

Narrowest policy, concretely:

- **Only the files the diff says changed** — never the whole approved or candidate tree. A Skill with
  40 files and a 1-file change uploads 1 file (old+new not even needed; the diff's `added`/`removed`/
  `modified` list plus the new file's content is sufficient for the "what changed" view — §10 of the
  original spec never asked for a full two-sided content viewer, just add/modify/remove + inspectable
  content).
- **Explicit CLI action only** — never automatic, never from `stak status`/`scan`/any background path.
- **Bounded size** (§5).
- **Owner-only authenticated access** — same RLS/ownership pattern every other per-user Cloud record
  already uses; never public, never cross-account-readable.
- **Deleted on invalidation** (§5) — content doesn't outlive its relevance.
- **Can approved-file inspection work without storing the whole approved tree?** Partially: the
  _currently-approved_ Skill's files are genuinely never uploaded by this design — only the **diff**
  (new/changed candidate files) is. A "browse the full approved tree" feature (contract §11's "file
  list + selected file" for a Skill with **no pending update**) is a **separate, larger privacy
  decision** this spike does not resolve — it would require uploading the whole approved tree, not just
  a diff, and should get its own explicit go/no-go rather than being bundled into the Update Review
  fix. Flagged, not decided.

## 7. Update-check model

Cloud's `SkillsReadModel`/`SkillDetail` would report **the latest artifact's recorded result**, with
`checkedAt`, never an independent live check. Concretely: `updateStatus` becomes a function of
"does a current (non-invalidated) artifact exist for this Skill, and what did it find" rather than a
live `checkSkillSource` call at read time.

**This changes frozen P3 language.** The contract's "Update available" definition currently implies a
live/near-live fact; under this model it means **"as of the last `stak skill check` run on some
machine, a candidate was found."** The product-facing copy needs an honest "as of" qualifier
(`checkedAt`, surfaced near the status), or the term itself needs a one-line clarification in
`docs/0.1.0-contract.md` §5. This is a genuine contract delta (see §12) — not edited yet, per
instructions.

## 8. Approval / stale-review semantics

**Design principle, matching your stated preference:** approve exactly the immutable artifact
reviewed, identified by its own id — never re-derive candidate fields from current source state.

Request shape: `{ entryId, artifactId }` (or `{ entryId, candidateRevision, candidateContentHash }` if
you prefer not to mint a separate artifact-id concept — functionally equivalent, artifact-id is just
more compact and avoids re-validating two fields for internal consistency).

Server-side verification, all already-available data, no new network calls:

1. Artifact belongs to the authenticated user (ownership check, same pattern as every other write).
2. Artifact's `entryId` matches the Skill being approved.
3. Artifact's `candidate.revision`/`candidate.contentHash` are internally consistent (they were set
   together at upload time by the CLI from a single `hashSkillTreeEntries` call — trivially true unless
   corrupted, worth asserting anyway).
4. Artifact's `approvedContentHash` (recorded at check time) still matches the Skill's **current**
   approved contentHash — if someone else (or another session) approved something else in between,
   this is the real staleness signal.
5. **Latest-known-only semantics, explicitly chosen per your preference:** if upstream has since moved
   from A to B but no new `stak skill check` ran, approving the still-current artifact for A **remains
   valid**. A is immutable, exactly what was reviewed, and approving it never implies B. The _next_
   `stak skill check` will independently surface B as a new, separate update-available fact. This is
   simpler and more honest than requiring Cloud to re-fetch upstream at approval time (which would
   reintroduce the exact server-side-Git problem §1 rejected).

**This changes the earlier P3 "stale candidate" interpretation.** The original `approveSkillVersion`
code's stale guard was "the submitted contentHash must equal the **current** `skill.contentHash`
already in the bundle" — i.e., staleness was about _your own prior approval_ moving under you, not
about _upstream_ moving. Under this model, staleness is about check 4 above (approved state moved) —
upstream moving is explicitly **not** staleness, per your preferred answer. Both are real concerns;
this spike flags that they're two different guards, not one, and the frozen contract currently only
describes the first. Not changed yet.

## 9. Local apply after approval — confirmed unchanged

```
web approves artifact A (exact candidate, exact content hash)
  -> Skill's approved/desired contentHash becomes A's candidateContentHash
  -> restoration reference advances to A's exact revision (same shape as today's
     approveSkillVersion — only the SOURCE of candidateContentHash/revision changes,
     from a client-trusted field to a server-verified artifact)
DELL may still report an older installed version
  -> UI shows the existing, already-correct reconciliation sentence
  -> user runs: stak skill update <skill>
  -> CLI fetches/restores the exact approved immutable reference (existing restoreReference
     path, unchanged)
  -> installed becomes approved
```

No change to this half of the flow at all — it's exactly what P5's Task 10/plan already assumed.

## 10. Private vs. public sources

| Source                               | Who fetches                                        | Credentials                                                                                               | Remote-check behavior                                                                                                                           |
| ------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Public Git                           | Local CLI only                                     | None needed (anonymous `ls-remote`/`fetch`)                                                               | Checkable via `stak skill check`                                                                                                                |
| Private Git                          | Local CLI only                                     | User's own existing local Git auth (SSH agent / credential helper) — **never** sent to or stored by Cloud | Checkable via `stak skill check`, exactly like public — Cloud never needs to distinguish public/private, because Cloud never fetches either one |
| Public-stack                         | Local CLI (via the existing public-stack resolver) | N/A (STAK's own registry)                                                                                 | Checkable the same way, artifact's `source.kind: 'public-stack'`                                                                                |
| Local                                | N/A                                                | N/A                                                                                                       | Fail-closed, `cannot-check`, reason `local` — unchanged, no artifact ever produced                                                              |
| Dirty/ambiguous Git                  | N/A                                                | N/A                                                                                                       | Fail-closed, unchanged                                                                                                                          |
| Pinned exact commit (no tracked ref) | N/A                                                | N/A                                                                                                       | Fail-closed `pinned`, unchanged — "intentionally not update-trackable" stays true                                                               |

Cloud never possesses, transmits, or needs private Git credentials under this model — the entire reason
the local-CLI-plane design is safer, not just simpler.

## 11. Failure / security model

| Case                                             | Behavior                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source unreachable                               | Existing fail-closed `uncheckable`/`unreachable` — no artifact produced, nothing uploaded                                                                                                                                                                             |
| Auth-required private remote, no local auth      | Same as unreachable from the CLI's perspective (git fetch fails) — fail-closed, no artifact                                                                                                                                                                           |
| Candidate too large / too many files             | CLI refuses to produce an artifact beyond the size/file-count cap (§5); reports `cannot-check` with a reason rather than silently truncating                                                                                                                          |
| Binary files in the diff                         | Content byte-size still counts toward the cap; the web only ever renders text for inspection (per original §11 of the P5 spec — "do not attempt to render arbitrary binary content as text") — binary diff entries show as a changed-file fact without a text preview |
| Symlinks / path traversal                        | Already rejected by `validateTreePath`/`UnsafeTreePathError` at tree-enumeration time — unchanged, reused as-is                                                                                                                                                       |
| Source moves mid-check                           | The CLI resolves once at the start of `stak skill check` and uses that single resolved revision for both the diff and the upload — no re-resolution mid-operation                                                                                                     |
| Approved version changes before upload completes | Upload still succeeds (artifact records the approvedContentHash it saw); becomes correctly stale/invalidated per §5/§8 whenever it's actually used                                                                                                                    |
| Artifact upload interrupted                      | Same partial-upload handling Memory's existing ticket-based blob flow already has (pending ticket, finalize-or-discard) — reused, not reinvented                                                                                                                      |
| Duplicate artifact upload                        | Same Skill checked twice → second upload replaces the first (per §5's "one latest, not history") — idempotent by design                                                                                                                                               |
| Artifact replay                                  | Artifact is tied to `(userId, entryId)` ownership and invalidated on approval — a replayed old artifact for an already-approved Skill fails check 4 in §8                                                                                                             |
| Cross-account access                             | Standard per-user ownership check, same as every other Cloud write/read in this codebase                                                                                                                                                                              |
| Artifact deletion                                | Explicit on invalidation (§5); also deletable via the same "delete cloud Memory"-style explicit user action if ever needed — not designed yet, not required for V0                                                                                                    |
| Candidate content execution                      | Never — read/hash/diff/display only, at every stage, local and Cloud alike                                                                                                                                                                                            |

## 12. Impact on current P5 design

**Can proceed unchanged today** (none of this blocks them, already built in Tasks 1–8 or still buildable without the artifact):

- Skills list: Ready / Paused / plain neutral-text install states
- Source provenance (safe label, tracked ref)
- Installed vs. approved version display
- Declared capabilities
- Pause / Resume (no content-hash dependency at all)
- Local-reconciliation command-dock guidance (`stak skill update <skill>`)
- All of Tasks 1–8 already built and reviewed in this session

**Must wait for the review-artifact closure:**

- Truthful "Update available" with a real, checkable backing fact (today it's always `cannot-check` in
  production, independent of P5 — this was already true before this session started)
- Candidate file content / exact diff rendering
- Web Approve action (the Critical bug Task 9's review caught — passing a revision string where a
  content hash belongs — has no correct fix until a real content hash exists somewhere)

Concretely: **Task 9 stays "needs fixes" and Task 10 (detail page, which also wires Approve) should not
proceed with a real Approve wiring** until this closure lands. Everything else in the original 14-task
plan is either already done (1–8, with Task 9's Critical finding open) or independent of this gap (the
remaining validation/dogfood tasks can proceed against Pause/Resume and the honest "not available yet"
states without the artifact).

## 13. Migration / API proposal (proposed only — not implemented)

- **New table** (name/number TBD, e.g. `supabase/migrations/00XX_skill_review_artifacts.sql`):
  `skill_review_artifacts(id, user_id, entry_id, approved_content_hash, source_kind, source_label,
tracked_ref, candidate_revision, candidate_content_hash, checked_at, diff_files jsonb, created_at)`,
  unique on `(user_id, entry_id)` (one latest, enforced at the DB level).
- **Blob storage**: reuse the existing blob store, keyed `(user_id, candidate_content_hash)` — no new
  bucket/subsystem.
- **New spec types** (`packages/spec/src/product.ts`): `SkillReviewArtifact`, matching §3's shape;
  `UploadSkillReviewArtifactRequest`.
- **New cloud-server endpoint/method**: `uploadSkillReviewArtifact(user, request)` — validates bounds,
  writes the DB row + blob, replacing any prior artifact for that `(user, entryId)`.
- **Modified `getSkillsReadModel`/`getSkillDetail`**: read the latest artifact (if any, if not
  invalidated) instead of calling an absent `checkSkillSource`; surface `checkedAt`.
- **Modified `approveSkillVersion`**: accept `artifactId` (or the `revision`+`contentHash` pair),
  verify per §8, and delete the artifact as part of the same commit.
- **New cloud-client method**: `uploadSkillReviewArtifact` (mirrors the existing Memory blob-ticket
  client calls).
- **New CLI command**: `stak skill check [<skill>]` (`packages/cli/src/commands/skill.ts`), plus a core
  function (e.g. `packages/core/src/skill-check.ts`) doing resolve → fetch-both-trees → diff → bound →
  upload, built from the already-existing primitives in §0.

No new persistence subsystem (no event table, no queue, no daemon) — one new table, one reused blob
store, matching your §12 constraint.

## 14. Frozen-contract deltas (not edited — flagged only)

From `docs/0.1.0-contract.md`:

- **§5 ("Skill update model")**: "Update available" needs an explicit "as of the last `stak skill
check`" qualifier — it is not, and under this model never will be, a live Cloud-side check.
- **§5's stale-review guard**: currently describes only "the submitted contentHash must match the
  Skill's current approved contentHash." Needs a second, explicit clause for "upstream moving after the
  artifact was created does NOT itself make the artifact stale" (§8 above) — otherwise a future reader
  could reasonably assume the opposite.
- **New privacy statement needed**: the contract's existing privacy language (§0, §3) states Memory
  content/paths are never sent to Cloud; it does not yet address Skill file content at all. A new
  clause is needed: "a bounded set of diff-relevant Skill file bytes may be uploaded to Cloud, only via
  an explicit `stak skill check`, only for files a diff reports as changed, deleted on
  approval/invalidation" (§6 above).
- **New CLI command to document**: `stak skill check [<skill>]` belongs in `docs/commands.md` alongside
  the existing `stak skill update/pause/resume` family.
- **Retention policy**: needs a one-line statement that review artifacts are ephemeral/latest-only, not
  part of the Skill's permanent version history (which remains untouched and already-correct).

## 15. Estimated implementation size

Rough file-count estimate, for sizing only:

- `packages/spec`: 1 file touched (new types + 2 request schemas) — small
- `packages/core`: 1 new file (`skill-check.ts`, built from §0's existing primitives) + tests — medium
- `packages/cloud-server`: `product-service.ts` modified (read model + approve), 1 new method, repository interface extended, + tests — medium
- `packages/cloud-client`: 1 new method + tests — small
- `packages/cli`: 1 new command (`skill check`) wired into `skill.ts`/`program.ts` + tests — small-medium
- `supabase/migrations`: 1 new migration — small
- `apps/web`: Task 9's `SkillActions` fixed to use the artifact's real fields; Task 10's detail
  view-model/page updated to read/render the artifact instead of `files:null`/`diff:null` — this part
  was already planned, just currently blocked
- Total: roughly comparable in size to one of the earlier phases (P2 or P3), not a small patch — but
  entirely additive, no architecture already built needs to be torn out.

## 16. Recommendation

Build the local-CLI-plane architecture (§2) as the fix for this gap. It:

- Requires zero new trust boundary on Cloud (no outbound arbitrary-remote fetching, no git binary
  dependency, no private-credential handling added to the server)
- Reuses every pure primitive already written in P2 (§0) — no parallel hashing/diff/resolution logic
- Reuses the exact bounded-upload pattern Memory already established — no new storage subsystem
- Makes "Update available" **honestly** checkable for the first time in this product (today it is
  silently always `cannot-check` in production) — a real correctness improvement, not just an
  unblocking of P5
- Keeps the narrowest possible privacy exception (diff-relevant files only, explicit action, bounded,
  owner-only, deleted on invalidation) rather than a blanket "upload everything" shortcut

This is sized as its own small phase (§15) — comparable to P2/P3 — not a quick patch inside P5. Given
that, I'd slot it as an explicit sub-phase (e.g. "P5a — Skill review artifact") before resuming P5's
Task 9 fix and Task 10, rather than trying to compress it into the existing P5 task list.
