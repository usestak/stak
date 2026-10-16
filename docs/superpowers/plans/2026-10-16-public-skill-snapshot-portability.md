# Public Skill Snapshot Portability — Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish wiring the already-landed (uncommitted) snapshot-storage primitives into the real publish flow, the public HTTP API, the CLI client, and `stak use`/`stak try` consumption, so a Skill with **no Git origin** (local/imported) can be published and consumed publicly through an immutable content-addressed snapshot, while legacy Git-reference published bundles keep working unchanged.

**Architecture:** Public Stack bundles already support a `restoration: reference | snapshot` discriminated union (`packages/spec/src/public.ts`) and a separate content-addressed `published/` blob namespace with `putPublished`/`getPublished`/`hasPublished` (`apps/web/lib/blob.ts`, `packages/cloud-server/src/memory.ts`, interface in `packages/cloud-server/src/repository.ts`). `ensurePublicSnapshotUploaded()` and `getPublicSkillSnapshot()` already exist in `packages/cloud-server/src/public-service.ts` but are not called from anywhere yet. This plan wires those three publish-time call sites, adds one new anonymous binary API route, adds one new Cloud-client method, and fixes two core CLI files (`remote-source.ts`, `composition.ts`) that the spec change already broke at the type level.

**Tech Stack:** TypeScript, Zod, Turborepo (`turbo run test|typecheck|lint|build`), Vitest (assumed — confirm per package), Next.js route handlers, Supabase Storage.

## Global Constraints

- Do NOT apply any production migration — confirmed none is required (content-addressed blob storage only, no new DB schema).
- Do NOT publish npm, do NOT tag, do NOT push.
- Do NOT amend commit `6288316` or any earlier commit — one new commit at the end: `feat(sharing): publish portable Skill snapshots`.
- Do NOT commit `packages/cli/memstk-cli-0.1.0.tgz`.
- Publication stays **all-or-nothing**: if any one selected Skill cannot be made publicly portable (snapshot upload fails, e.g. owner hasn't `stak push`ed it), the whole publish fails with an actionable error — never silently omit a Skill.
- Legacy `reference`-only published bundles must keep resolving through the existing Git/reference pathway, unchanged.
- No DB migration, no raw storage key/path exposure, no generic 500s for the "not yet pushed" case.
- No individual Skill content browsing/discovery feature — the new route is for CLI snapshot consumption only.
- No licensing infrastructure — only a one-line honest publish-time notice in the web UI.
- CLI version stays `0.1.0` for the final pack/install verification.

---

## File Structure

| File                                                                                                    | Responsibility                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cloud-server/src/service.ts`                                                                  | Thread `blobStore` into `createPublicStackService(...)` (currently omitted).                                                                                                                                                                                   |
| `packages/cloud-server/src/user-stack-service.ts`                                                       | `buildCandidateBundle` — named-Stack publish: emit `snapshot` restoration + call `ensurePublicSnapshotUploaded`, instead of rejecting.                                                                                                                         |
| `packages/cloud-server/src/skill-share-service.ts`                                                      | `shareSkill` — single-Skill share: same change.                                                                                                                                                                                                                |
| `packages/core/src/public-stack.ts`                                                                     | `buildPublicStackBundle` — CLI-side legacy anonymous publish path: same change, client-side "has this been pushed" check instead of server blob read.                                                                                                          |
| `packages/cloud-server/src/handler.ts`                                                                  | New anonymous `GET .../snapshots/:hash` binary route, mirroring the existing authenticated `GET /snapshots/:hash/download` shape.                                                                                                                              |
| `packages/cloud-client/src/client.ts`                                                                   | New `getPublicSkillSnapshot(owner, slug, versionNumber, contentHash)` method on `PublicStackClient`.                                                                                                                                                           |
| `packages/core/src/remote-source.ts`                                                                    | `resolvePublicStackSource` — stop assuming every requirement has `.restoration.reference`; keep the raw `restoration` per requirement.                                                                                                                         |
| `packages/core/src/composition.ts`                                                                      | `applyRemoteStackUse` — branch on `requirement.restoration.strategy`; snapshot path fetches via the new client method, verifies digest, extracts via `extractSnapshotArchiveToStore` (the same function the private/authenticated download path already uses). |
| `packages/cli/src/commands/try.ts`                                                                      | Confirm it shares `resolvePublicStackSource`/`prepareRemoteStackUse`/`applyRemoteStackUse` with `use.ts`; if it has its own duplicate logic, fix in parallel.                                                                                                  |
| `apps/web/app/staks/_components/edit-stak-form.tsx`, `apps/web/app/staks/actions.ts`                    | Surface a clear "run `stak push` first" error when `ensurePublicSnapshotUploaded` throws `publicationNotEligible`; add the one-line redistribution notice near the Publish action.                                                                             |
| Test files across `packages/spec`, `packages/cloud-server`, `packages/core`, `packages/cli`, `apps/web` | New coverage per Tasks 10–13 below.                                                                                                                                                                                                                            |

---

### Task 1: Wire `blobStore` into `PublicServiceContext` everywhere

**Files:**

- Modify: `packages/cloud-server/src/service.ts:184-189`
- Modify: `packages/cloud-server/src/public-service.ts` (no change needed — `PublicServiceContext.blobStore` already typed; confirm)
- Test: wherever `cloud-server` tests construct a `PublicServiceContext`/`CloudService` directly — grep first.

**Interfaces:**

- Consumes: `config.blobStore: CloudBlobStore` (already exists on `CloudServiceConfig`, used elsewhere at `service.ts:219-221`).
- Produces: `createPublicStackService({ repository, blobStore, nowIso, newId, appUrl })` — the shape every later task's publish-flow changes depend on (`ensurePublicSnapshotUploaded` and `getPublicSkillSnapshot` both need `ctx.blobStore`).

- [ ] **Step 1: Read the exact current call**

Read `packages/cloud-server/src/service.ts` lines 170-225 to confirm the exact surrounding object literal before editing.

- [ ] **Step 2: Add `blobStore` to the call**

```ts
const publicMethods = createPublicStackService({
  repository: config.repository,
  blobStore: config.blobStore,
  nowIso,
  newId,
  appUrl,
});
```

- [ ] **Step 3: Find every other construction site**

Run: `grep -rn "createPublicStackService(" packages/cloud-server/src --include=*.test.ts`
Also run: `grep -rln "restoration" packages/cloud-server/src/*.test.ts`

For each test file that builds its own `PublicServiceContext` or a `CloudService` config object missing `blobStore`, add an in-memory blob store (`createInMemoryBlobStore()` from `packages/cloud-server/src/memory.ts`) to the fixture.

- [ ] **Step 4: Typecheck this package in isolation**

Run: `cd packages/cloud-server && npx tsc --noEmit`
Expected: no error about a missing `blobStore` property anywhere `PublicServiceContext` or `CloudServiceConfig` is constructed.

- [ ] **Step 5: Commit is deferred to the end of the whole plan (Task 16) — do not commit yet.**

---

### Task 2: Publish-time snapshot wiring in `buildCandidateBundle` (named Stack publish)

**Files:**

- Modify: `packages/cloud-server/src/user-stack-service.ts:183-272`
- Test: `packages/cloud-server/src/user-stack-service.test.ts` (confirm exact filename via `ls packages/cloud-server/src/*user-stack*`)

**Interfaces:**

- Consumes: `ensurePublicSnapshotUploaded(blobStore, ownerUserId, contentHash, skillName): Promise<void>` (already implemented, throws `publicationNotEligible(message)` on missing owner bytes — `packages/cloud-server/src/public-service.ts`).
- Consumes: `skill.restoration: PortableRestorationStrategy` (either `{strategy:'reference', reference}` or `{strategy:'snapshot', contentHash, reason}` — confirm exact private-side shape by reading `packages/spec/src/storage.ts` for `PortableRestorationStrategy`/`snapshotRestorationSchema` before editing).
- Produces: each built requirement's `restoration: PublicStackRestoration` — `{strategy:'reference', reference}` unchanged for git-backed Skills, `{strategy:'snapshot', contentHash}` (per `publicSnapshotRestorationSchema`) for snapshot-backed Skills.

- [ ] **Step 1: Read current logic in full**

Read `packages/cloud-server/src/user-stack-service.ts` lines 183-272 completely (the function signature, the `MAX_REQUIREMENTS` loop, the current line ~220-223 rejection, and line 215-243 mapping) before editing anything.

- [ ] **Step 2: Write the failing test first**

In the test file, add a case: build a candidate Stack containing one Skill whose `restoration.strategy === 'snapshot'` and whose content bytes exist in the owner-scoped blob store (seed via `blobStore.put(ownerUserId, contentHash, bytes)`), call `publishUserStack(...)`, and assert the resulting public version's bundle contains a requirement with `restoration: { strategy: 'snapshot', contentHash }` — not a thrown `publicationNotEligible`.

Add a second case: same but the owner-scoped blob store has NOT been seeded with that `contentHash` — assert `publishUserStack(...)` rejects with a `publicationNotEligible` error whose message mentions `stak push`, and assert the whole publish is atomic (no partial public version was created — re-fetch the Stack's public versions list and confirm it's still empty/unchanged).

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `cd packages/cloud-server && npx vitest run user-stack-service` (confirm exact test command from `package.json` `scripts.test` first if this guess is wrong)
Expected: FAIL — current code still throws `publicationNotEligible` unconditionally for snapshot-strategy skills (first case), and the second case may pass accidentally or fail for the wrong reason.

- [ ] **Step 4: Replace the rejection with real wiring**

Where the function currently does (approximately, confirm exact lines from Step 1):

```ts
if (skill.restoration.strategy !== 'reference') {
  throw publicationNotEligible(/* ... */);
}
```

replace with an async branch (the surrounding map/loop must become awaited — check whether it's currently a `.map` that needs to become a `for...of` with `await` inside, since `ensurePublicSnapshotUploaded` is async):

```ts
let restoration: PublicStackRestoration;
if (skill.restoration.strategy === 'snapshot') {
  await ensurePublicSnapshotUploaded(
    ctx.blobStore,
    ownerUserId,
    skill.restoration.contentHash,
    skill.name,
  );
  restoration = {
    strategy: 'snapshot',
    contentHash: skill.restoration.contentHash,
  };
} else {
  restoration = {
    strategy: 'reference',
    reference: skill.restoration.reference,
  };
}
```

Keep this inside the existing all-or-nothing loop structure: if `ensurePublicSnapshotUploaded` throws for any one Skill, the entire `buildCandidateBundle`/`publishUserStack` call must reject before any public version row or snapshot copy for _other_ Skills is persisted — confirm (from Step 1's read) whether the existing loop already uploads/persists other Skills before this one fails, and if so restructure to validate/upload all Skills' snapshots first, then persist the version row only after every one succeeds.

- [ ] **Step 5: Run the tests to confirm they pass**

Run the same vitest command as Step 3.
Expected: PASS, both cases.

- [ ] **Step 6: Confirm existing reference-only tests still pass**

Run: `cd packages/cloud-server && npx vitest run` (full package)
Expected: no regressions in pre-existing publish tests.

---

### Task 3: Same wiring in `shareSkill` (single-Skill share)

**Files:**

- Modify: `packages/cloud-server/src/skill-share-service.ts:157-193`
- Test: `packages/cloud-server/src/skill-share-service.test.ts`

**Interfaces:**

- Consumes/Produces: identical to Task 2, applied at `shareSkill`'s line 163 rejection point instead.

- [ ] **Step 1: Read current logic in full**

Read `packages/cloud-server/src/skill-share-service.ts` lines 157-193 completely.

- [ ] **Step 2: Write failing tests** mirroring Task 2 Step 2, scoped to `shareSkill`'s single-Skill bundle shape.

- [ ] **Step 3: Run tests, confirm failure.**

Run: `cd packages/cloud-server && npx vitest run skill-share-service`

- [ ] **Step 4: Apply the same branch** as Task 2 Step 4 at line 163's rejection point.

- [ ] **Step 5: Run tests, confirm pass.**

- [ ] **Step 6: Run full `cloud-server` suite, confirm no regressions.**

Run: `cd packages/cloud-server && npx vitest run`

---

### Task 4: Same wiring in the CLI-side legacy anonymous publish path

**Files:**

- Modify: `packages/core/src/public-stack.ts:40-108` (`buildPublicStackBundle`, and `resolvePublishSource` in the same file)
- Test: `packages/core/src/public-stack.test.ts` (confirm name via `ls packages/core/src/*public-stack*`)

**Interfaces:**

- Consumes: this path runs **client-side** in the CLI, not server-side — it cannot call `ensurePublicSnapshotUploaded` (no blob store access). Read lines 1-108 in full first to determine what local check already exists for "has this Skill's content been pushed" (likely something in `packages/core/src/cloud-restore.ts` or a `push` command helper) and reuse it, or if none exists, this path should push the content as part of publish rather than requiring a prior separate `stak push` — confirm which behavior the existing legacy `stack publish <arg>` CLI command already offers before deciding, since this is the anonymous (non-named-Stack) publish path and may have different UX expectations than Tasks 2/3.
- Produces: same `restoration: {strategy:'snapshot', contentHash}` shape as Tasks 2/3, for parity with the server-side bundle shape consumed by `stak use`.

- [ ] **Step 1: Read current logic and the current explicit V0 rejection**

Read `packages/core/src/public-stack.ts` lines 1-108 in full, noting the exact text of the "Public snapshot publishing is not supported in V0" rejection (lines 43-51) and what triggers this code path (which CLI command calls `buildPublicStackBundle`/`resolvePublishSource` — grep `resolvePublishSource(` across `packages/cli/src`).

- [ ] **Step 2: Write failing test(s)** for: a snapshot-strategy Skill passed into `buildPublicStackBundle` now produces a `snapshot`-restoration requirement instead of throwing, using whatever upload/push primitive Step 1 determined is correct for this client-side path.

- [ ] **Step 3: Run tests, confirm failure.**

Run: `cd packages/core && npx vitest run public-stack`

- [ ] **Step 4: Replace the V0 rejection** with the real implementation determined in Step 1.

- [ ] **Step 5: Run tests, confirm pass.**

- [ ] **Step 6: Run full `core` suite, confirm no regressions** (baseline 138/138 per directive — expect this to grow).

Run: `cd packages/core && npx vitest run`

---

### Task 5: Anonymous public snapshot-bytes API route

**Files:**

- Modify: `packages/cloud-server/src/handler.ts` (add new route near existing lines 385-451)
- Test: `packages/cloud-server/src/handler.test.ts` (confirm name)

**Interfaces:**

- Consumes: `service.getPublicSkillSnapshot(owner, slug, versionNumber, contentHash): Promise<Uint8Array>` (already implemented in `public-service.ts`, already throws `publicStackNotFound(...)` for every unauthorized case — unpublished Stack, wrong version, contentHash not in that version's bundle, bytes missing).
- Produces: `GET` route matching segment shape `['stacks', owner, slug, 'versions', String(versionNumber), 'snapshots', contentHash]` (length 7), returning the same binary response shape as the existing private download route: `{status:200, headers:{'content-type':'application/octet-stream'}, binaryBody: bytes}`. No `authenticate()` call — anonymous.

- [ ] **Step 1: Read the exact existing patterns before writing**

Read `packages/cloud-server/src/handler.ts` lines 380-460 in full (both the authenticated private download route at 385-407 and the anonymous public-stack routes at 429-451) to copy the exact segment-matching idiom, error-to-HTTP-status mapping, and binary response shape used in this file.

- [ ] **Step 2: Write a failing test**

Add a case to `handler.test.ts`: publish a Stack version containing a snapshot requirement (reusing whatever test helper Task 2 added), then issue a raw `GET` request through `handleCloudRequest` for the new route shape with the correct owner/slug/version/hash, with **no** auth header, and assert `status === 200`, `headers['content-type'] === 'application/octet-stream'`, and `binaryBody` equals the expected bytes.

Add failure cases (feeds directly into Task 11's matrix — write them here too, don't duplicate later): wrong contentHash → 404-equivalent `publicStackNotFound`; unpublished Stack → same; version number that isn't the currently published one but was a prior published version (if the version-history contract makes old versions still resolvable) → still 200 with that version's own hash.

- [ ] **Step 3: Run tests, confirm failure** (route doesn't exist yet → whatever "no route matched" fallback this handler returns, likely a 404 with a different body shape).

Run: `cd packages/cloud-server && npx vitest run handler`

- [ ] **Step 4: Add the route**

Insert, adjacent to the existing `stacks/:owner/:slug` and `.../versions/:n` blocks, matching this file's exact existing style (read Step 1's output before writing — do not guess bracket/if-chain style):

```ts
if (
  method === 'GET' &&
  segments.length === 7 &&
  segments[0] === 'stacks' &&
  segments[3] === 'versions' &&
  segments[5] === 'snapshots'
) {
  const owner = segments[1];
  const slug = segments[2];
  const versionNumber = Number(segments[4]);
  const contentHash = segments[6];
  const bytes = await service.getPublicSkillSnapshot(
    owner,
    slug,
    versionNumber,
    contentHash,
  );
  return {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
    binaryBody: bytes,
  };
}
```

(Adjust to match this file's actual error-catching wrapper, numeric parsing/validation idiom, and whatever outer try/catch already converts thrown service errors to HTTP statuses — read Step 1 before finalizing, since `publicStackNotFound` must map to the same status the existing public routes already map it to.)

- [ ] **Step 5: Run tests, confirm pass.**

- [ ] **Step 6: Run full `cloud-server` suite.**

---

### Task 6: Cloud client method for fetching a public snapshot

**Files:**

- Modify: `packages/cloud-client/src/client.ts` (near existing `PublicStackClient` methods, ~line 171+, and `downloadSnapshot` impl at 553-577 for response-handling style reference)
- Test: `packages/cloud-client/src/client.test.ts` (confirm name)

**Interfaces:**

- Consumes: the Task 5 route, hit anonymously.
- Produces: `getPublicSkillSnapshot(owner: string, slug: string, versionNumber: number, contentHash: string): Promise<Uint8Array>` on `PublicStackClient`, used by Task 8's `composition.ts` change.

- [ ] **Step 1: Read existing patterns**

Read `packages/cloud-client/src/client.ts` around the `PublicStackClient` interface and its `getPublicStack`/`getPublicStackVersion` implementations (auth:false, URL building, response parsing), plus `downloadSnapshot` (127, 553-577) for how this codebase already handles a raw-bytes response vs a JSON response, before writing.

- [ ] **Step 2: Write a failing test** using this file's existing mock-fetch/mock-transport test pattern (copy whatever `getPublicStackVersion`'s test already does), asserting the method hits the right URL with `auth:false` and returns the raw bytes unmodified.

- [ ] **Step 3: Run test, confirm failure.**

- [ ] **Step 4: Implement**

```ts
getPublicSkillSnapshot: async (
  owner: string,
  slug: string,
  versionNumber: number,
  contentHash: string,
): Promise<Uint8Array> => {
  const path = `stacks/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/versions/${versionNumber}/snapshots/${encodeURIComponent(contentHash)}`;
  return request(path, { auth: false, binary: true }); // adjust to this file's actual low-level request helper name/signature — read Step 1 output first
},
```

- [ ] **Step 5: Run test, confirm pass.**

- [ ] **Step 6: Run full `cloud-client` suite.**

---

### Task 7: Fix `resolvePublicStackSource` for the discriminated union

**Files:**

- Modify: `packages/core/src/remote-source.ts:72-111`
- Test: `packages/core/src/remote-source.test.ts`

**Interfaces:**

- Consumes: `PublicStackVersionResponse.bundle.requirements[].restoration: PublicStackRestoration` (now `reference | snapshot`).
- Produces: `ResolvedPublicStackSource` must stop pre-building an eager `references: Map<string, ReferenceRecord>` keyed by assuming every requirement has `.restoration.reference` (this line currently breaks typecheck: `requirement.restoration.reference` doesn't exist on the `snapshot` variant). Instead expose the raw per-requirement `restoration` so `composition.ts` (Task 8) can branch on `.strategy` at use-time. Name the new/changed field so Task 8's consumption matches exactly — suggest keeping `requirements: PublicStackRequirement[]` (or whatever the existing full-requirement list field is already called elsewhere in this file) rather than a pre-reduced reference-only map.

- [ ] **Step 1: Read full current implementation**

Read `packages/core/src/remote-source.ts` lines 1-111 in full, including the `ResolvedPublicStackSource` type definition (wherever it is — likely in this file or `packages/core/src/types.ts`), before changing anything, since this is the type Task 8 depends on.

- [ ] **Step 2: Write failing test**

Add a case: a `PublicStackVersionResponse` containing one `snapshot`-strategy requirement and one `reference`-strategy requirement, assert `resolvePublicStackSource(...)` returns a source whose per-requirement data correctly preserves `restoration.strategy` for both, without throwing or dropping either.

- [ ] **Step 3: Run test, confirm failure** (or confirm it's currently a typecheck failure, not a runtime one — run `npx tsc --noEmit` in this package first).

Run: `cd packages/core && npx tsc --noEmit`
Expected: TS error on the `requirement.restoration.reference` line if the partial diff's schema change already broke this (per the research findings) — fix this first before worrying about the vitest case.

- [ ] **Step 4: Fix the implementation** — replace the eager reference-only map with a structure preserving full per-requirement `restoration`, matching whatever field name/shape Task 8 needs (write Task 8's read first if sequencing allows, otherwise pick the minimal change: keep the requirements array as-is and remove/replace just the broken `.reference` access).

- [ ] **Step 5: Run `tsc --noEmit` again, confirm clean. Run vitest, confirm the new test passes and no existing ones broke.**

Run: `cd packages/core && npx vitest run remote-source`

---

### Task 8: Fix `applyRemoteStackUse` to consume both restoration strategies

**Files:**

- Modify: `packages/core/src/composition.ts:693-744`
- Test: `packages/core/src/composition.test.ts`

**Interfaces:**

- Consumes: `cloudClient.getPublicSkillSnapshot(owner, slug, versionNumber, contentHash)` (Task 6), `extractSnapshotArchiveToStore(options): Promise<{contentHash: string; reused: boolean}>` (`packages/store/src/archive.ts:260` — same function the private/authenticated `cloud-restore.ts:253-259` path already uses), `verifyStoredSkill({stackHome, contentHash})` (`packages/store/src/store.ts:137`, to skip re-fetching already-present content).
- Produces: `applyRemoteStackUse` composes a snapshot-restored Skill into `main` identically to a reference-restored one — same conflict handling, dry-run, JSON output, stable IDs, path fences, atomic mutation semantics (read the existing function fully before touching it so these guarantees are provably preserved, not just asserted).

- [ ] **Step 1: Read full current implementation**

Read `packages/core/src/composition.ts` lines 601-744 in full (`prepareRemoteStackUse` and `applyRemoteStackUse`), plus `packages/core/src/cloud-restore.ts` lines 230-270 (the existing private snapshot-download+extract+verify call site) as the exact pattern to mirror for the public path.

- [ ] **Step 2: Write failing test(s)**

In `composition.test.ts`, add: a `ResolvedPublicStackSource` with one snapshot-strategy requirement not yet present locally; call `applyRemoteStackUse`; assert it calls the public-snapshot fetch, verifies the returned content's derived hash matches the expected `contentHash` (tamper case: feed back mismatched bytes from a test double and assert it rejects with a clear error and does **not** mutate `main`), and on success extracts into the local content store and composes into `main` the same way a reference-restored Skill would (assert on the resulting `main` state, not just "no throw").

- [ ] **Step 3: Run tests, confirm failure.**

Run: `cd packages/core && npx vitest run composition`
Expected: current code throws `StackCompositionError('remote-reference-missing', ...)` for the snapshot case.

- [ ] **Step 4: Implement the branch**

Where the function currently unconditionally does `proposal.source.references.get(requirement.id)` then `restoreReference(...)` for anything missing locally, branch first:

```ts
if (requirement.restoration.strategy === 'snapshot') {
  if (
    await verifyStoredSkill({
      stackHome,
      contentHash: requirement.restoration.contentHash,
    })
  ) {
    // already present locally — reuse directly, same as any other content-addressed hit
  } else {
    const bytes = await cloudClient.getPublicSkillSnapshot(
      source.owner,
      source.slug,
      source.versionNumber,
      requirement.restoration.contentHash,
    );
    const { contentHash: actualHash } = await extractSnapshotArchiveToStore({
      stackHome,
      bytes,
      // ...other options exactly as cloud-restore.ts's existing call passes them — copy, don't invent
    });
    if (actualHash !== requirement.restoration.contentHash) {
      throw new StackCompositionError(
        'remote-snapshot-integrity-mismatch',
        `The public Skill snapshot for "${requirement.name}" did not match its expected content hash. It was not installed.`,
      );
    }
  }
  // fall through to the same compose-into-main step reference-restored requirements already use
} else {
  // existing reference-restoration branch, unchanged
}
```

(Match exact existing error type/constructor and the exact compose-into-`main` call already used after a successful reference restore — read Step 1's output before finalizing so both paths converge on the identical downstream call.)

- [ ] **Step 5: Run tests, confirm pass.**

- [ ] **Step 6: Run full `core` suite, confirm no regressions.**

---

### Task 9: Confirm/fix `stak try` shares the same resolver

**Files:**

- Modify (if needed): `packages/cli/src/commands/try.ts`, `packages/cli/src/ui/try.ts`
- Test: `packages/cli/src/commands/try.test.ts`

**Interfaces:**

- Consumes: `resolvePublicStackSource` (Task 7), `prepareRemoteStackUse`/`applyRemoteStackUse` (Task 8) — or whichever trial-specific equivalents `try.ts` actually calls.

- [ ] **Step 1: Read `try.ts` and `ui/try.ts` in full** to determine whether trial composition reuses `applyRemoteStackUse` against a trial root, or has its own separate implementation.

- [ ] **Step 2a (if shared):** Write a test proving a snapshot-strategy requirement resolves correctly through `stak try`, confirm it already passes once Tasks 7–8 land (no production code change needed here beyond the shared fix) — run it, confirm pass, done.

- [ ] **Step 2b (if NOT shared — try.ts has its own restoration-handling code):** Read that code in full, apply the same branch as Task 8 Step 4 there, write a failing test first, confirm failure, implement, confirm pass.

- [ ] **Step 3: Add/confirm trial-isolation assertions** — in whichever test file is appropriate, assert: trial environment remains isolated, user's `main` is unchanged after `try`, cleanup behavior removes the trial root, snapshot files extracted during `try` do not escape the trial root (reuse `assertSafeSymlinkTarget`'s existing guarantee — add a test that a malicious extracted entry with a traversal/symlink target is rejected inside the trial path specifically, not just the private path), and no creator-local paths leak into the trial output.

- [ ] **Step 4: Run `cli` suite, confirm pass, no regressions.**

Run: `cd packages/cli && npx vitest run`

---

### Task 10: Version immutability test (V1/V2)

**Files:**

- Test: add to `packages/cloud-server/src/user-stack-service.test.ts` (or wherever Task 2's tests live)

**Interfaces:**

- Consumes: `publishUserStack` (Task 2), `getPublicSkillSnapshot`/`getPublicStackVersion` (existing + Task 5).

- [ ] **Step 1: Write the test**

Publish a named Stack with one local Skill whose content snapshot hash is `A`. Capture the resulting version number (`V1`). Mutate the Skill's local content (new hash `B`) and republish the same named Stack (`V2`). Assert:

- `getPublicStackVersion(owner, slug, 1)`'s bundle still references hash `A`.
- `getPublicStackVersion(owner, slug, 2)`'s bundle references hash `B`.
- `service.getPublicSkillSnapshot(owner, slug, 1, A)` returns the original bytes.
- `service.getPublicSkillSnapshot(owner, slug, 2, B)` returns the new bytes.
- `service.getPublicSkillSnapshot(owner, slug, 1, B)` throws `publicStackNotFound` (hash B does not belong to V1's bundle — proves no cross-version leakage).
- `getPublicStack(owner, slug)` ("current publication") resolves to V2 per whatever the existing "current version" semantics already are (read that logic before asserting, don't invent new semantics).

- [ ] **Step 2: Run, confirm pass** (this exercises Tasks 2 + 5 together — if it fails, the bug is in one of those, not a new implementation needed here).

---

### Task 11: All-local regression + authorization matrix + path-safety tests

**Files:**

- Test: `packages/cloud-server/src/user-stack-service.test.ts` and/or a new `packages/cloud-server/src/public-skill-snapshot.test.ts` if the existing files are getting unwieldy (reader's judgment at write time — follow existing file-size conventions in this package).

**Interfaces:** same as Tasks 2, 5, 10.

- [ ] **Step 1: All-local regression**

Write a test: 3 Skills, all `restoration.strategy === 'snapshot'`, zero git-backed, seeded into the owner-scoped blob store. Publish a named Stack selecting all 3. Assert the public bundle contains exactly 3 requirements, all `restoration.strategy === 'snapshot'`. Then, using a fresh/anonymous service instance (no auth), resolve the public version and fetch all 3 snapshots via `getPublicSkillSnapshot`, asserting each returns the correct bytes with no git source consulted anywhere in the call path.

- [ ] **Step 2: Authorization matrix (A–H from the directive)**

Add one test per letter, reusing fixtures from Tasks 2/5/10:

- A: published snapshot fetched anonymously → succeeds.
- B: snapshot belonging to a built-but-unpublished version → `getPublicSkillSnapshot` throws not-found.
- C: a valid contentHash that exists in the owner-scoped (private) blob store but was never published anywhere → throws not-found (prove the public route never reads the private namespace directly).
- D: a syntactically-valid-looking but never-uploaded contentHash → throws not-found (not a 500, not a crash).
- E: an old but still-public version's snapshot remains retrievable after a newer version is published (depends on Task 10's version-immutability contract already holding).
- F: a snapshot belonging only to a Stack that was never published (still draft/private) → throws not-found even with a syntactically correct owner/slug/version/hash combination.
- G: a second user attempting to publish/modify the first user's named Stack → still rejected by whatever existing ownership check already guards `publishUserStack` (this should already pass — write the test to prove it wasn't weakened by this feature, not to add new logic).
- H: every one of A/E's successful fetches is called with no auth/session token at all, proving creator login is never required for public retrieval.

- [ ] **Step 3: Path-safety / traversal / symlink tests**

In `packages/store/src/archive.test.ts` (or wherever `extractSnapshotArchiveToStore`'s existing tests live — confirmed one such test already exists per research, "rejects extracting a symlink that escapes the tree"), add cases specific to the public-consumption path (Task 8/9): a crafted archive entry targeting `../`, an absolute path, or a symlink pointing outside the stack/trial root, fetched through the public snapshot flow, is rejected before any file is written outside the intended root — assert by checking the filesystem state outside the root is untouched, not just that an error was thrown.

- [ ] **Step 4: Run full suites for all touched packages, confirm all pass.**

---

### Task 12: Web publication UX — push-required error + redistribution notice

**Files:**

- Modify: `apps/web/app/staks/_components/edit-stak-form.tsx`
- Modify: `apps/web/app/staks/actions.ts`
- Test: this component's existing test file (confirm name via `ls apps/web/app/staks/_components/*.test.*`)

**Interfaces:**

- Consumes: `publicationNotEligible` error thrown by `ensurePublicSnapshotUploaded` (Task 2), which per the existing implementation already carries a message like `"<skillName>'s content hasn't been uploaded to STAK Cloud yet. Run \`stak push\` first, then try sharing again."` — surface this message as-is to the user rather than a generic failure, since it's already written to be user-facing.

- [ ] **Step 1: Read both files in full** to find the current Publish action's error handling and where a redistribution notice would sit naturally (near the Publish button/confirmation, not buried).

- [ ] **Step 2: Write a failing test**

Mock the publish action to reject with the `publicationNotEligible`-shaped error and assert the form renders that exact message (or a clearly derived, non-generic version of it) rather than a generic "Something went wrong."

- [ ] **Step 3: Run test, confirm failure** (if the current code already passes this through generically, confirm whether it's actually already fine — don't force a change where none is needed; report either way).

- [ ] **Step 4: Implement the clear error surfacing** if Step 3 showed a gap.

- [ ] **Step 5: Add the one-line redistribution notice** near the Publish action, concise and non-legal:
      "Publishing makes this Skill's contents publicly available. Only publish content you have permission to share."

- [ ] **Step 6: Run the component's test suite, confirm pass.**

Run: `cd apps/web && npx vitest run edit-stak-form` (confirm exact command)

---

### Task 13: Grep for stale snapshot-ineligibility assumptions in the web UI

**Files:** `apps/web/**` (read-only investigation, then fix only if found)

- [ ] **Step 1: Grep for stale assumptions**

Run: `grep -rn "assessSkillShareEligibility\|SnapshotReason\|snapshot.*ineligible\|eligible" apps/web --include=*.tsx --include=*.ts`

- [ ] **Step 2: For each hit**, read surrounding context and confirm it correctly treats snapshot-strategy Skills as publishable now (per the already-flipped `skill-share.ts`). Fix any UI that still filters them out of a "select Skills to publish" list, with a test proving a snapshot-strategy (no-Git) Skill now appears as selectable.

- [ ] **Step 3: Run `apps/web` suite, confirm pass.**

---

### Task 14: Spec/contract documentation update

**Files:** whatever file in this repo is the source-of-truth contract/spec doc for public Stacks (grep `docs/` for the existing public-Stack contract doc before guessing a path — likely near wherever P10's sharing spec already lives, referenced by the `claude-mem` timeline as "P10 — Shareable Skills + Named Stacks").

- [ ] **Step 1: Find the doc**

Run: `grep -rln "restoration\|reference-only\|public Stack bundle" docs/`

- [ ] **Step 2: Update it** to describe: public Stack versions carry immutable portable Skill snapshots by default for new publications; Git provenance is retained as optional metadata, never a runtime dependency, for new publications; legacy reference-only restoration remains supported for versions published before this change; anonymous retrieval is authorized only through published-public-version membership (the exact check `getPublicSkillSnapshot` performs), never through bucket-level access. Do not rewrite unrelated historical sections.

---

### Task 15: Full validation sweep

- [ ] **Step 1: Confirm baselines, then run everything**

Run in order, recording exact pass/fail counts for each (from directive: CLI 268/268, core 138/138, web 343/343 baselines before this feature's new tests — counts are expected to grow):

```bash
turbo run typecheck
turbo run lint
npx prettier --check .
git diff --check
turbo run test
turbo run build
```

- [ ] **Step 2: If Windows parallel-run contention recurs**, use whatever isolation/serialization process this project has already established for it (check `docs/superpowers/plans/` prior entries and `MEMORY.md`'s `pnpm-native-binary-fix.md` note for any recorded workaround) and report it honestly — do not silently skip or weaken a test to work around contention.

- [ ] **Step 3: Fix any regression** surfaced by this sweep before proceeding — do not proceed to packaging with a red suite.

---

### Task 16: Package the CLI and verify a fresh install

- [ ] **Step 1: Build and pack**

```bash
cd packages/cli
npm run build
npm pack
```

Keep version `0.1.0` — do not bump.

- [ ] **Step 2: Inspect package contents**

```bash
tar -tzf memstk-cli-0.1.0.tgz
```

Confirm no unexpected files (test fixtures, `.env`, etc.) are included.

- [ ] **Step 3: Fresh isolated install**

Using a fresh scratch directory (NOT the repo), fresh `STAK_HOME` and fresh `USERPROFILE`/`HOME` env vars pointed at a temp dir, install the freshly packed tarball globally or locally and run:

```bash
stak --version
```

Confirm it reports `0.1.0`.

- [ ] **Step 4: Exercise public snapshot consumption against a local/fixture server**

Using whatever local test-server fixture this repo already has for CLI integration tests (grep `packages/cli` for an existing local-server test harness before inventing one), run a real `stak use @owner/name` and/or `stak try @owner/name <agent>` against a published Stack containing snapshot-strategy requirements, confirming end-to-end success outside of vitest mocks.

- [ ] **Step 5: Leave the tarball untracked** — do not add it to git. Confirm via `git status` it still shows as untracked (or remove/recreate it, since the directive says either is fine for the final manual test).

---

### Task 17: Final commit

- [ ] **Step 1: Stage only the intended files**

```bash
git status
```

Review the full list. Stage the 6 pre-existing partial files plus every file this plan touched. Explicitly exclude `packages/cli/memstk-cli-0.1.0.tgz`.

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(sharing): publish portable Skill snapshots

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Confirm**

```bash
git log -1 --stat
git status
```

Confirm `6288316` is still the commit directly before this new one (not amended), and the tarball is absent from the commit.

- [ ] **Step 4: Do NOT push, tag, or publish.** Stop here and produce the final report (the 24-point list from the original directive) in the conversation, not as a new file.

---

## Self-Review Notes

- **Spec coverage:** Directive sections 1–22 map onto Tasks 1–17 as follows: §1→2–4, §2→1, §3→5, §4→6–7, §5→7–8, §6→9, §7→8 (integrity branch), §8→10, §9→2–4 (git-backed path unchanged, same branch handles both), §10→11 Step 1, §11→11 Step 2, §12→11 Step 3, §13→12, §14→12, §15→12 Step 5, §16→ constraint only, no new route added for browsing (confirmed by Task 5's route shape being snapshot-bytes-only, not a content browser), §17→ constraint honored throughout (no rewriting of legacy behavior), §18→14, §19→15, §20→16, §21→17, §22→ the final conversational report, not a file.
- **Open unknowns deliberately left for execution-time reads** (not placeholders — each task's Step 1 names the exact file/lines to read before writing code, because this plan was written from a research pass, not a full file inventory): exact test runner invocation per package (vitest vs other), exact `PortableRestorationStrategy`/`ResolvedPublicStackSource` type definitions, exact `try.ts` sharing status with `use.ts`, exact low-level HTTP request helper name in `cloud-client`, exact location of the public-Stack contract doc.
