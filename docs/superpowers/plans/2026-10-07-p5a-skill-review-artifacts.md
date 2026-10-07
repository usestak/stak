# P5a — Skill Review Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dormant, never-wired `checkSkillSource` live-check model with a local-CLI-plane
architecture: the CLI resolves sources, materializes the exact candidate + approved trees using the
user's own credentials, computes a deterministic diff, and uploads one bounded, latest-only review
artifact per Skill. Cloud never fetches arbitrary Git remotes and never holds private Git credentials;
it stores/serves that artifact and validates approval against it. Web approves by immutable
`reviewArtifactId`, never by resubmitting candidate fields itself. This unblocks P5's Update
Review/Approve flow, which is currently blocked on a Critical finding (Task 9 of the P5 plan passed a
source-revision string into a field that requires a real content hash — a hash that, until this phase,
nothing in the system ever computes or stores).

**Architecture:** `docs/0.1.0-contract.md` §5a and `docs/architecture/skill-review-artifact-spike.md`
are already frozen (commit `c61cfb7`) and are the binding source of truth for every semantic decision
below — this plan only implements what they already specify. Three new pieces: (1) a new
`skill_review_checks` table (DB metadata, latest-only) + the existing content-addressed blob store
(bounded text payload, reused unchanged); (2) a new CLI command `stak skill check` built from existing
P2 primitives (`resolveSkillSourceLatest`, `diffSkillTrees`, `hashSkillTreeEntries`,
`validateTreePath`) plus one new local materialization function; (3) Cloud-side read/write methods that
read the latest stored check instead of calling the never-wired `checkSkillSource`, and an
approve-by-artifact flow with explicit stale/superseded verification.

**Tech Stack:** TypeScript, Zod (`@stack/spec`), Vitest, Supabase/Postgres (migration only — not
applied), existing CLI (`commander`)/cloud-server/cloud-client packages.

## Global Constraints

- Branch `p5-skills-detail` only (same branch P5 is on). Do not start P6. Do not push.
- **Do not apply the migration to any Supabase environment** (dev or production) during this phase —
  create the file only.
- **Do not run `stak skill check` against the real 31-Skill account.** Do not upload real Skill
  content. All materialization/upload/approval tests use synthetic local Git fixture repositories
  (same pattern `restoreReference`'s own tests likely use — a local bare repo created in a temp dir) or
  in-memory fakes. Do not approve/pause/resume anything in the real account.
- **Cloud never fetches arbitrary Git remotes and never holds private Git credentials.** No code in
  `packages/cloud-server` or `apps/web` may spawn `git` or make an outbound fetch to a user-configured
  remote. All Git/network materialization lives in `packages/core`/`packages/cli`, run locally.
- **`candidateContentHash` trust model (frozen):** the CLI is the sole producer; Cloud validates
  schema/ownership/base-identity/payload-integrity (via the separate, Cloud-verifiable
  `artifactPayloadHash`) and bounds — Cloud never claims to have independently recomputed the full
  candidate tree hash. Never write code that implies otherwise (e.g., no comment or log message
  claiming "Cloud verified the content hash").
- **Approval is by `reviewArtifactId` only.** The browser/web layer must never submit
  `candidateRevision`/`candidateContentHash` to the approve endpoint. Cloud loads its own stored
  artifact and approves the identity recorded inside it.
- **Latest-only, base-bound retention (frozen):** one stored check/artifact per `(userId, skillId)`.
  A result is current only while `storedCheck.approvedContentHash === Skill.approvedContentHash`.
  Pause/resume never invalidates a stored check (it doesn't change approved content). Replacement
  order is safety-critical: new metadata commits successfully **before** the old blob is deleted — a
  failed/interrupted re-upload must never lose the previously-valid artifact.
- **Stale/superseded semantics (frozen, do not reinterpret):** an artifact remains approvable even if
  upstream has since moved past it, as long as no *newer* `stak skill check` has superseded it and the
  Skill's approved base hasn't changed under it. A newer check for the same Skill supersedes the old
  one. An approved-base change invalidates the old one. These are the only two invalidation triggers.
- **Three source-check states, distinct from the structural cannot-check note (frozen):** "no update" /
  "update available" / "not checked yet" are all distinct from "Can't check for updates from this
  source" (reserved for Local/dirty/ambiguous/pinned/resolution-failure) and from "Check failed"
  (transient network/auth failure during an explicit check — never collapsed into a permanent
  cannot-check judgment, never exposes raw Git stderr).
- **Bounds (exact V0 numbers, used consistently across every task):** max 200 changed files per
  artifact; max 2 MiB total uploaded artifact bytes; max 256 KiB for any single text file's content.
  Exceeding any bound means **no artifact is produced or uploaded** — `stak skill check` still reports
  `update-available` at the summary level (there genuinely is an update) but with no review payload;
  the web must render an honest "exceeds V0 review limits, can't be reviewed here" state and must not
  expose a working Approve button for that Skill.
- **Full approved-tree browsing stays deferred.** Do not upload or display the complete approved
  Skill tree outside an active update review. Provenance/history/capabilities/pause-resume render
  exactly as P5 already built them.
- Privacy: no absolute/home-relative paths, no Git credentials/tokens, no unrelated repository
  content, no cross-account access, owner-scoped only, never published to any public stack.

---

## File Structure

New:
- `packages/core/src/skill-check.ts` — candidate+approved materialization, diff, bounds, binary
  classification (pure where possible; network/filesystem at the edges).
- `packages/core/src/skill-check.test.ts`
- `supabase/migrations/0006_skill_review_checks.sql` — **not applied**.
- `packages/cli/src/commands/skill-check.ts` *or* an addition to `packages/cli/src/commands/skill.ts`
  (decided in Task 8 based on the existing file's size) — the `stak skill check [<skill>]` command.
- `packages/adapters/src/skill-update-integrity.test.ts` — the Task 9 "proof" test.

Modified:
- `packages/spec/src/product.ts` — new `sourceCheckStateSchema`, `cannotCheckReasonSchema`,
  `reviewArtifactFileSchema`, `skillReviewArtifactSchema`, `uploadSkillReviewArtifactRequestSchema`,
  `reportSkillSourceCheckRequestSchema`; `skillSummarySchema`/`skillDetailSchema` reshaped;
  `approveSkillVersionRequestSchema` reshaped; `skillFileSchema`/`skillDiffFileSchema` removed
  (superseded by `reviewArtifactFileSchema`).
- `packages/cloud-server/src/repository.ts` — `CloudRepository` gains
  `getSkillReviewCheck`/`putSkillReviewCheck`/`deleteSkillReviewCheck`; new
  `SkillReviewCheckRecord` type.
- `packages/cloud-server/src/memory.ts` — in-memory fixture implements the 3 new methods.
- `packages/cloud-server/src/product-service.ts` — `skillSummaries()` reads the stored check instead
  of calling the removed `checkSkillSource`; new `uploadSkillReviewArtifact`/`reportSkillSourceCheck`
  service methods; `approveSkillVersion` rewritten to approve-by-artifact.
- `packages/cloud-server/src/service.ts` / `handler.ts` — new route(s), `checkSkillSource` config
  option removed.
- `packages/cloud-server/src/product.test.ts` — extensive additions/edits.
- `packages/cloud-client/src/client.ts` + its test file — new upload/report methods, updated approve
  call shape.
- `packages/cli/src/program.ts` — wires the new command's real dependencies.
- `apps/web/lib/repository.ts` — Supabase-backed implementation of the 3 new repository methods.
- `apps/web/app/skills/skills-data.ts` / `skill-detail-data.ts` / `actions.ts` / `[skillId]/page.tsx` /
  `_components/skills-table.tsx` / `_components/skill-actions.tsx` — updated for the new fields and
  approve-by-artifact; fixes the Critical finding from P5 Task 9's review.
- Corresponding `*.test.ts` files for every file above that has one today.

---

### Task 1: Spec types

**Files:**
- Modify: `packages/spec/src/product.ts`
- Modify/create: `packages/spec/src/product.test.ts` (add if absent; check first — the plan's earlier
  investigation did not confirm one exists, so create it if `packages/spec/src/` has no test for this
  file; otherwise add to the existing one)

**Interfaces:**
- Produces: `sourceCheckStateSchema` (`'no-update' | 'update-available' | 'not-checked' |
  'cannot-check' | 'check-failed'`), `cannotCheckReasonSchema` (`'local' | 'dirty' | 'ambiguous' |
  'unreachable' | 'pinned'`), `reviewArtifactFileSchema`, `skillReviewArtifactSchema`,
  `uploadSkillReviewArtifactRequestSchema`, `reportSkillSourceCheckRequestSchema`, and their inferred
  types (`SourceCheckState`, `CannotCheckReason`, `ReviewArtifactFile`, `SkillReviewArtifact`,
  `UploadSkillReviewArtifactRequest`, `ReportSkillSourceCheckRequest`). Reshaped
  `skillSummarySchema`/`SkillSummary`, `skillDetailSchema`/`SkillDetail`,
  `approveSkillVersionRequestSchema`/`ApproveSkillVersionRequest`.
- Removes: `skillUpdateStatusSchema`/`SkillUpdateStatus` (superseded by `sourceCheckStateSchema`),
  `skillFileSchema`/`SkillFile`, `skillDiffFileSchema`/`SkillDiffFile` (superseded by
  `reviewArtifactFileSchema`) — these are only one phase old (added in P5 Task 7) and consumed solely
  by files this plan's Task 10 also rewrites, so removing them is safe; grep for any other consumer
  before deleting (none are expected outside `apps/web/app/skills/`).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/spec/src/product.test.ts (new file if one doesn't exist for product.ts; otherwise append)
import { describe, expect, it } from 'vitest';

import {
  approveSkillVersionRequestSchema,
  reviewArtifactFileSchema,
  skillReviewArtifactSchema,
  skillSummarySchema,
  sourceCheckStateSchema,
  uploadSkillReviewArtifactRequestSchema,
} from './product.js';

const HASH = 'sha256:' + 'a'.repeat(64);
const HASH2 = 'sha256:' + 'b'.repeat(64);

describe('sourceCheckStateSchema', () => {
  it('accepts exactly the five frozen states', () => {
    for (const s of ['no-update', 'update-available', 'not-checked', 'cannot-check', 'check-failed'])
      expect(sourceCheckStateSchema.parse(s)).toBe(s);
  });
  it('rejects an invented state', () => {
    expect(sourceCheckStateSchema.safeParse('ready').success).toBe(false);
  });
});

describe('approveSkillVersionRequestSchema', () => {
  it('accepts only skillId + reviewArtifactId, never candidate fields', () => {
    const parsed = approveSkillVersionRequestSchema.parse({
      skillId: 'skill_test0001',
      reviewArtifactId: '00000000-0000-4000-8000-000000000001',
    });
    expect(parsed).toEqual({
      skillId: 'skill_test0001',
      reviewArtifactId: '00000000-0000-4000-8000-000000000001',
    });
  });
  it('rejects a browser-supplied candidateContentHash (strict schema)', () => {
    const result = approveSkillVersionRequestSchema.safeParse({
      skillId: 'skill_test0001',
      reviewArtifactId: '00000000-0000-4000-8000-000000000001',
      candidateContentHash: HASH,
    });
    expect(result.success).toBe(false);
  });
});

describe('reviewArtifactFileSchema', () => {
  it('accepts a modified text file with before/after content', () => {
    const parsed = reviewArtifactFileSchema.parse({
      relativePath: 'SKILL.md',
      kind: 'modified',
      binary: false,
      before: { byteSize: 10, hash: HASH },
      after: { byteSize: 12, hash: HASH2 },
      beforeText: 'old',
      afterText: 'new',
    });
    expect(parsed.kind).toBe('modified');
  });
  it('accepts a binary file with no text content', () => {
    const parsed = reviewArtifactFileSchema.parse({
      relativePath: 'assets/logo.png',
      kind: 'modified',
      binary: true,
      before: { byteSize: 100, hash: HASH },
      after: { byteSize: 200, hash: HASH2 },
    });
    expect(parsed.beforeText).toBeUndefined();
    expect(parsed.afterText).toBeUndefined();
  });
});

describe('skillReviewArtifactSchema', () => {
  it('parses a complete artifact', () => {
    const parsed = skillReviewArtifactSchema.parse({
      reviewArtifactId: '00000000-0000-4000-8000-000000000001',
      skillId: 'skill_test0001',
      approvedContentHash: HASH,
      candidateRevision: 'abc123',
      candidateContentHash: HASH2,
      artifactPayloadHash: 'sha256:' + 'c'.repeat(64),
      checkedAt: new Date().toISOString(),
      files: [],
    });
    expect(parsed.skillId).toBe('skill_test0001');
  });
});

describe('uploadSkillReviewArtifactRequestSchema', () => {
  it('bounds files to 200 entries', () => {
    const files = Array.from({ length: 201 }, (_, i) => ({
      relativePath: `f${i}.txt`,
      kind: 'added' as const,
      binary: false,
      after: { byteSize: 1, hash: HASH },
      afterText: 'x',
    }));
    const result = uploadSkillReviewArtifactRequestSchema.safeParse({
      skillId: 'skill_test0001',
      approvedContentHash: HASH,
      candidateRevision: 'abc123',
      candidateContentHash: HASH2,
      artifactPayloadHash: 'sha256:' + 'c'.repeat(64),
      checkedAt: new Date().toISOString(),
      files,
    });
    expect(result.success).toBe(false);
  });
});

describe('skillSummarySchema', () => {
  it('has no updateStatus/candidateVersion fields — sourceCheckState/candidateRevision instead', () => {
    const parsed = skillSummarySchema.parse({
      skillId: 'skill_test0001',
      name: 'test',
      approvedVersion: HASH,
      paused: false,
      source: { kind: 'git', checkable: true },
      capability: { declared: false },
      sourceCheckState: 'not-checked',
      checkedAt: null,
      installs: [],
    });
    expect(parsed.sourceCheckState).toBe('not-checked');
    expect('updateStatus' in parsed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spec && npx vitest run src/product.test.ts`
Expected: FAIL — the new schemas don't exist yet.

- [ ] **Step 3: Implement the schema changes**

In `packages/spec/src/product.ts`, replace the `skillUpdateStatusSchema` block and everything through
`skillDetailSchema` with:

```typescript
/** Structural inability to check vs. a transient failure vs. simply not yet checked (P5a §5a). */
export const cannotCheckReasonSchema = z.enum([
  'local',
  'dirty',
  'ambiguous',
  'unreachable',
  'pinned',
]);

/**
 * The latest CLI-reported source-check result for one Skill (P5a §5a). `not-checked` and
 * `cannot-check` are DISTINCT: the former means a checkable source simply has no current
 * CLI-reported result; the latter means the source is structurally uncheckable (Local,
 * dirty/ambiguous, pinned, resolution failure). `check-failed` is a transient network/auth
 * failure during an explicit check — never collapsed into `cannot-check`.
 */
export const sourceCheckStateSchema = z.enum([
  'no-update',
  'update-available',
  'not-checked',
  'cannot-check',
  'check-failed',
]);

/** Source provenance summary — a safe classification, never a path or remote credential. */
export const skillSourceSummarySchema = z.object({
  kind: z.enum(['git', 'public-stack', 'local', 'snapshot']),
  checkable: z.boolean(),
  // A human-safe label (e.g. a repo+ref or `@owner/slug`), never a local path.
  label: z.string().optional(),
  trackedRef: z.string().optional(),
});

/** Declared-capability state (contract §7): absent = "not declared", never defaulted false. */
export const capabilityStateSchema = z.object({
  declared: z.boolean(),
  capabilities: declaredCapabilitiesSchema.optional(),
});

export const skillInstallSchema = z.object({
  machineId: z.uuid(),
  name: z.string().optional(),
  installedVersion: contentHashSchema.nullable(),
});

/** One changed file inside a review artifact (P5a §5a/§7/§8). Unchanged files never appear. */
export const reviewArtifactFileSchema = z
  .object({
    relativePath: z.string().min(1),
    kind: z.enum(['added', 'modified', 'removed']),
    binary: z.boolean(),
    before: z
      .object({ byteSize: z.number().int().nonnegative(), hash: z.string().min(1) })
      .optional(),
    after: z
      .object({ byteSize: z.number().int().nonnegative(), hash: z.string().min(1) })
      .optional(),
    // Present only when !binary; a binary file never carries a text preview.
    beforeText: z.string().optional(),
    afterText: z.string().optional(),
  })
  .strict();
export type ReviewArtifactFile = z.infer<typeof reviewArtifactFileSchema>;

/**
 * One immutable, bounded review artifact (P5a §5a/§1/§2). Produced entirely by the CLI;
 * Cloud stores and serves it, verifying only `artifactPayloadHash` (the bounded payload it
 * actually holds) — never claiming to have independently recomputed `candidateContentHash`
 * (the full candidate tree hash, which Cloud never materializes).
 */
export const skillReviewArtifactSchema = z
  .object({
    reviewArtifactId: z.uuid(),
    skillId: entryIdSchema,
    approvedContentHash: contentHashSchema,
    candidateRevision: z.string().min(1),
    candidateContentHash: contentHashSchema,
    artifactPayloadHash: z.string().min(1),
    checkedAt: timestamp,
    files: z.array(reviewArtifactFileSchema).max(200),
  })
  .strict();
export type SkillReviewArtifact = z.infer<typeof skillReviewArtifactSchema>;

/** CLI → Cloud upload for an update-available result (P5a §13/§16 bounds). */
export const uploadSkillReviewArtifactRequestSchema = z
  .object({
    skillId: entryIdSchema,
    approvedContentHash: contentHashSchema,
    candidateRevision: z.string().min(1),
    candidateContentHash: contentHashSchema,
    artifactPayloadHash: z.string().min(1),
    checkedAt: timestamp,
    files: z.array(reviewArtifactFileSchema).max(200),
  })
  .strict();
export type UploadSkillReviewArtifactRequest = z.infer<
  typeof uploadSkillReviewArtifactRequestSchema
>;
export type UploadSkillReviewArtifactResponse = { reviewArtifactId: string };

/** CLI → Cloud report for a no-artifact result: no-update, cannot-check, or check-failed. */
export const reportSkillSourceCheckRequestSchema = z
  .object({
    skillId: entryIdSchema,
    approvedContentHash: contentHashSchema,
    sourceCheckState: z.enum(['no-update', 'cannot-check', 'check-failed']),
    checkedAt: timestamp,
    cannotCheckReason: cannotCheckReasonSchema.optional(),
    // Sanitized only — never raw Git stderr, which may contain credentials/URLs.
    failureReason: z.string().max(500).optional(),
  })
  .strict();
export type ReportSkillSourceCheckRequest = z.infer<
  typeof reportSkillSourceCheckRequestSchema
>;

export const skillSummarySchema = z.object({
  skillId: entryIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  approvedVersion: contentHashSchema,
  paused: z.boolean(),
  source: skillSourceSummarySchema,
  capability: capabilityStateSchema,
  sourceCheckState: sourceCheckStateSchema,
  checkedAt: timestamp.nullable(),
  // Present only when sourceCheckState === 'update-available'.
  candidateRevision: z.string().optional(),
  reviewArtifactId: z.uuid().optional(),
  // Present only when sourceCheckState === 'cannot-check'.
  cannotCheckReason: cannotCheckReasonSchema.optional(),
  // Present only when sourceCheckState === 'check-failed'.
  checkFailedReason: z.string().optional(),
  installs: z.array(skillInstallSchema),
});

export const skillsReadModelSchema = z.object({
  environmentExists: z.boolean(),
  skills: z.array(skillSummarySchema),
});

export const skillVersionHistoryEntrySchema = z.object({
  contentHash: contentHashSchema,
  environmentVersionNumber: z.number().int().positive(),
  approvedAt: timestamp,
});

export const skillDetailSchema = skillSummarySchema.extend({
  history: z.array(skillVersionHistoryEntrySchema),
  // The full artifact, only when sourceCheckState === 'update-available'; null otherwise,
  // including when bounds were exceeded (no artifact was ever produced — see contract §5a).
  reviewArtifact: skillReviewArtifactSchema.nullable(),
});
```

Then, in the "Skill write requests" section, replace `approveSkillVersionRequestSchema`:

```typescript
export const approveSkillVersionRequestSchema = z
  .object({
    skillId: entryIdSchema,
    reviewArtifactId: z.uuid(),
  })
  .strict();
```

`setSkillPausedRequestSchema` is unchanged.

In the "Types" section, remove `SkillUpdateStatus`, `SkillFile`, `SkillDiffFile` type exports (and
their schemas if still present from P5's own edits), add:

```typescript
export type CannotCheckReason = z.infer<typeof cannotCheckReasonSchema>;
export type SourceCheckState = z.infer<typeof sourceCheckStateSchema>;
```

Keep `SkillSourceSummary`, `CapabilityState`, `SkillInstall`, `SkillSummary`, `SkillsReadModel`,
`SkillDetail`, `SkillVersionHistoryEntry` as-is (their underlying schemas changed shape but the export
names stay the same).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/spec && npx vitest run src/product.test.ts`
Expected: PASS

- [ ] **Step 5: Grep for now-dead imports**

Run: `cd "C:/Users/NT/Desktop/stack" && grep -rn "SkillUpdateStatus\|SkillFile\b\|SkillDiffFile\|skillUpdateStatusSchema\|skillFileSchema\|skillDiffFileSchema" packages apps --include="*.ts" --include="*.tsx"`

This will find consumers in `packages/cloud-server/src/product-service.ts` and
`apps/web/app/skills/*.ts` — expected; Tasks 6 and 10 fix those. Note anything unexpected in your
report; do not fix files outside this task's scope here.

- [ ] **Step 6: Commit**

```bash
git add packages/spec/src/product.ts packages/spec/src/product.test.ts
git commit -m "feat(p5a): spec types for Skill review artifacts and approve-by-artifact"
```

---

### Task 2: Migration (not applied)

**Files:**
- Create: `supabase/migrations/0006_skill_review_checks.sql`

**Interfaces:** none (SQL only; no application code depends on this file directly — Task 3/4 write
against the `CloudRepository` interface, which the real Supabase implementation in Task 4 backs with
this table).

- [ ] **Step 1: Write the migration**

```sql
-- 0006_skill_review_checks.sql — P5a: local-CLI-plane Skill source checking.
--
-- Backward compatible and additive: one new table, no existing column/table changes meaning.
-- Latest-only per (user_id, skill_id) — a newer `stak skill check` replaces the row; an
-- approved-base change invalidates (the service layer deletes) the row. No history is kept
-- in V0 (contract §5a).
--
-- Privacy: this table stores ONLY safe metadata (source-check state, candidate revision,
-- content hashes, a changed-file list with path/kind/binary/before-after SIZE+HASH — never
-- file text content, never a Git credential, never an absolute/home-relative path). The
-- bounded diff-relevant file TEXT content lives in the existing content-addressed blob store,
-- keyed by (user_id, artifact_payload_hash) — reused unchanged, not a new storage subsystem.
-- Writes happen through the service role; RLS grants owners read-only access.

create table if not exists public.skill_review_checks (
  user_id uuid not null references auth.users (id) on delete cascade,
  skill_id text not null,
  approved_content_hash text not null,
  source_check_state text not null
    check (source_check_state in ('no-update', 'update-available', 'cannot-check', 'check-failed')),
  checked_at timestamptz not null,

  cannot_check_reason text
    check (cannot_check_reason in ('local', 'dirty', 'ambiguous', 'unreachable', 'pinned')),
  check_failed_reason text,

  candidate_revision text,
  candidate_content_hash text,

  review_artifact_id uuid,
  artifact_payload_hash text,
  -- Changed-file list: [{ relativePath, kind, binary, before?: {byteSize,hash}, after?: {byteSize,hash} }].
  -- Never contains file text content — that lives in the blob store keyed by artifact_payload_hash.
  diff_files jsonb,

  created_at timestamptz not null default now(),
  primary key (user_id, skill_id)
);

create index if not exists skill_review_checks_owner_idx
  on public.skill_review_checks (user_id);

alter table public.skill_review_checks enable row level security;

-- Owner read-only; all writes go through the service role (account-side service logic).
create policy skill_review_checks_owner_select on public.skill_review_checks
  for select using (auth.uid() = user_id);
```

- [ ] **Step 2: Validate SQL syntax without applying it**

Run: `cd "C:/Users/NT/Desktop/stack" && npx supabase db lint --schema public 2>&1 | head -50` if the
`supabase` CLI is available in this environment; if it is not (no network/binary), skip this step and
note it in the report — **do not** run `supabase db push`/`migration up` or anything that applies the
migration, under any circumstance, regardless of whether linting is available.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0006_skill_review_checks.sql
git commit -m "feat(p5a): add skill_review_checks migration (not applied)"
```

---

### Task 3: `CloudRepository` interface + in-memory fixture

**Files:**
- Modify: `packages/cloud-server/src/repository.ts`
- Modify: `packages/cloud-server/src/memory.ts`
- Create: `packages/cloud-server/src/repository.test.ts` if no such file exists for the in-memory
  fixture today (check first: `packages/cloud-server/src/*.test.ts` — if `memory.ts`'s behavior is
  already exercised only indirectly through `product.test.ts`, add the new tests there instead, as a
  new top-level `describe` block, to match the existing convention).

**Interfaces:**
- Produces: `SkillReviewCheckRecord` type (mirrors `skill_review_checks` columns in camelCase);
  `CloudRepository.getSkillReviewCheck(userId, skillId): Promise<SkillReviewCheckRecord | null>`,
  `CloudRepository.putSkillReviewCheck(record: SkillReviewCheckRecord): Promise<void>` (upsert —
  replaces any existing row for that `(userId, skillId)`), `CloudRepository.deleteSkillReviewCheck(
  userId, skillId): Promise<void>`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

```typescript
// Add to packages/cloud-server/src/memory.test.ts (create if absent) or as a new describe
// block in an existing in-memory-fixture test file — follow whichever convention
// `createInMemoryRepository`'s other methods are already tested under.
import { describe, expect, it } from 'vitest';

import { createInMemoryRepository } from './memory.js';
import type { SkillReviewCheckRecord } from './repository.js';

const USER = 'user-1';
const SKILL = 'skill_test0001';
const HASH = 'sha256:' + 'a'.repeat(64);

const record = (
  over: Partial<SkillReviewCheckRecord> = {},
): SkillReviewCheckRecord => ({
  userId: USER,
  skillId: SKILL,
  approvedContentHash: HASH,
  sourceCheckState: 'update-available',
  checkedAt: new Date().toISOString(),
  candidateRevision: 'abc123',
  candidateContentHash: 'sha256:' + 'b'.repeat(64),
  reviewArtifactId: '00000000-0000-4000-8000-000000000001',
  artifactPayloadHash: 'sha256:' + 'c'.repeat(64),
  diffFiles: [],
  ...over,
});

describe('in-memory CloudRepository: skill review checks', () => {
  it('returns null when no check has ever been stored', async () => {
    const repo = createInMemoryRepository();
    expect(await repo.getSkillReviewCheck(USER, SKILL)).toBeNull();
  });
  it('stores and retrieves a check', async () => {
    const repo = createInMemoryRepository();
    await repo.putSkillReviewCheck(record());
    expect(await repo.getSkillReviewCheck(USER, SKILL)).toEqual(record());
  });
  it('a newer put REPLACES the prior check (latest-only)', async () => {
    const repo = createInMemoryRepository();
    await repo.putSkillReviewCheck(record({ candidateRevision: 'old' }));
    await repo.putSkillReviewCheck(record({ candidateRevision: 'new' }));
    const stored = await repo.getSkillReviewCheck(USER, SKILL);
    expect(stored?.candidateRevision).toBe('new');
  });
  it('delete removes the check', async () => {
    const repo = createInMemoryRepository();
    await repo.putSkillReviewCheck(record());
    await repo.deleteSkillReviewCheck(USER, SKILL);
    expect(await repo.getSkillReviewCheck(USER, SKILL)).toBeNull();
  });
  it('scopes by both userId and skillId — another user/skill is unaffected', async () => {
    const repo = createInMemoryRepository();
    await repo.putSkillReviewCheck(record());
    expect(await repo.getSkillReviewCheck('other-user', SKILL)).toBeNull();
    expect(await repo.getSkillReviewCheck(USER, 'skill_other0001')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cloud-server && npx vitest run` (point at the specific new test file/describe block
once you've decided where it lives per the brief's file-location instruction)
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Implement**

In `packages/cloud-server/src/repository.ts`, add near the other record types:

```typescript
export type ReviewArtifactFileRecord = {
  relativePath: string;
  kind: 'added' | 'modified' | 'removed';
  binary: boolean;
  before?: { byteSize: number; hash: string };
  after?: { byteSize: number; hash: string };
};

export type SkillReviewCheckRecord = {
  userId: string;
  skillId: string;
  approvedContentHash: string;
  sourceCheckState: 'no-update' | 'update-available' | 'cannot-check' | 'check-failed';
  checkedAt: string;
  cannotCheckReason?: 'local' | 'dirty' | 'ambiguous' | 'unreachable' | 'pinned';
  checkFailedReason?: string;
  candidateRevision?: string;
  candidateContentHash?: string;
  reviewArtifactId?: string;
  artifactPayloadHash?: string;
  diffFiles?: ReviewArtifactFileRecord[];
};
```

Add to the `CloudRepository` interface:

```typescript
  /** Latest-only Skill source-check result (P5a §5a). Null when never checked. */
  getSkillReviewCheck(
    userId: string,
    skillId: string,
  ): Promise<SkillReviewCheckRecord | null>;
  /** Upsert, replacing any existing row for this (userId, skillId) — latest-only. */
  putSkillReviewCheck(record: SkillReviewCheckRecord): Promise<void>;
  deleteSkillReviewCheck(userId: string, skillId: string): Promise<void>;
```

In `packages/cloud-server/src/memory.ts`, inside `createInMemoryRepository`'s returned object, add
(following the file's existing `Map`-backed style for similar per-user keyed state):

```typescript
  const skillReviewChecks = new Map<string, SkillReviewCheckRecord>();
  const checkKey = (userId: string, skillId: string) => `${userId}:${skillId}`;
  // ... inside the returned object:
  getSkillReviewCheck: async (userId, skillId) =>
    skillReviewChecks.get(checkKey(userId, skillId)) ?? null,
  putSkillReviewCheck: async (record) => {
    skillReviewChecks.set(checkKey(record.userId, record.skillId), record);
  },
  deleteSkillReviewCheck: async (userId, skillId) => {
    skillReviewChecks.delete(checkKey(userId, skillId));
  },
```

Place the `Map` declaration alongside the file's other per-fixture `Map`s (near the top of
`createInMemoryRepository`'s body, not inside the returned object), and import
`SkillReviewCheckRecord` from `./repository.js`.

- [ ] **Step 4: Run test to verify it passes**

Run the same command as Step 2.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cloud-server/src/repository.ts packages/cloud-server/src/memory.ts
# plus whichever test file you added to
git commit -m "feat(p5a): CloudRepository skill-review-check storage (in-memory)"
```

---

### Task 4: Supabase-backed repository implementation

**Files:**
- Modify: `apps/web/lib/repository.ts`

**Interfaces:**
- Consumes: `SkillReviewCheckRecord`, `ReviewArtifactFileRecord` from `@stack/cloud-server` (Task 3).
- Produces: the same 3 methods, backed by `public.skill_review_checks` (Task 2's table).

- [ ] **Step 1: Implement, following the existing `hasSnapshot`/`getSnapshot`/`putSnapshot` pattern
  exactly** (snake_case columns, `mapX`-style row mapper, `db()` client accessor already used
  throughout this file)

```typescript
const mapSkillReviewCheck = (row: any): SkillReviewCheckRecord => ({
  userId: row.user_id,
  skillId: row.skill_id,
  approvedContentHash: row.approved_content_hash,
  sourceCheckState: row.source_check_state,
  checkedAt: row.checked_at,
  ...(row.cannot_check_reason ? { cannotCheckReason: row.cannot_check_reason } : {}),
  ...(row.check_failed_reason ? { checkFailedReason: row.check_failed_reason } : {}),
  ...(row.candidate_revision ? { candidateRevision: row.candidate_revision } : {}),
  ...(row.candidate_content_hash ? { candidateContentHash: row.candidate_content_hash } : {}),
  ...(row.review_artifact_id ? { reviewArtifactId: row.review_artifact_id } : {}),
  ...(row.artifact_payload_hash ? { artifactPayloadHash: row.artifact_payload_hash } : {}),
  ...(row.diff_files ? { diffFiles: row.diff_files } : {}),
});

// Inside the returned object, alongside hasSnapshot/getSnapshot/putSnapshot:
getSkillReviewCheck: async (userId, skillId) => {
  const { data } = await db()
    .from('skill_review_checks')
    .select('*')
    .eq('user_id', userId)
    .eq('skill_id', skillId)
    .maybeSingle();
  return data ? mapSkillReviewCheck(data) : null;
},
putSkillReviewCheck: async (record) => {
  await db().from('skill_review_checks').upsert({
    user_id: record.userId,
    skill_id: record.skillId,
    approved_content_hash: record.approvedContentHash,
    source_check_state: record.sourceCheckState,
    checked_at: record.checkedAt,
    cannot_check_reason: record.cannotCheckReason ?? null,
    check_failed_reason: record.checkFailedReason ?? null,
    candidate_revision: record.candidateRevision ?? null,
    candidate_content_hash: record.candidateContentHash ?? null,
    review_artifact_id: record.reviewArtifactId ?? null,
    artifact_payload_hash: record.artifactPayloadHash ?? null,
    diff_files: record.diffFiles ?? null,
  });
},
deleteSkillReviewCheck: async (userId, skillId) => {
  await db()
    .from('skill_review_checks')
    .delete()
    .eq('user_id', userId)
    .eq('skill_id', skillId);
},
```

Add `SkillReviewCheckRecord` to the file's existing `@stack/cloud-server` type import list.

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS — this file has no dedicated unit test today (it talks to real Supabase), consistent
with its siblings; do not add one that mocks the Supabase client beyond what already exists in this
file's test coverage, if any.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/repository.ts
git commit -m "feat(p5a): Supabase-backed skill review check storage"
```

---

### Task 5: Candidate + approved tree materialization (`packages/core`)

**Files:**
- Create: `packages/core/src/skill-check.ts`
- Create: `packages/core/src/skill-check.test.ts`

**Interfaces:**
- Consumes: `resolveSkillSourceLatest`, `SourceLatestResult`, `resolvePublicStackSourceLatest`,
  `diffSkillTrees`, `SkillTreeDiff` (`packages/core/src/skill-source.ts`); `enumerateSkillTree`,
  `hashSkillTreeEntries`, `validateTreePath`, `SkillTreeEntry` (`@stack/shared`); `spawnGit`,
  `GitExecutor` (`packages/core/src/git-reference.ts`).
- Produces: `materializeExactRevision(options): Promise<SkillTreeEntry[]>` (shallow-fetch one exact
  Git revision's Skill subtree into a temp dir, enumerate it, clean up — no Store ingestion, this is
  ephemeral, used for both the approved and candidate sides); `buildReviewArtifactFiles(approved:
  SkillTreeEntry[], candidate: SkillTreeEntry[], bounds): ReviewArtifactFilesResult` (pure — the diff +
  bounds + binary-classification + before/after-text logic); `type ReviewArtifactFilesResult = {
  status: 'ok'; files: ReviewArtifactFileRecord[] } | { status: 'exceeds-bounds' }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/core/src/skill-check.test.ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SkillTreeEntry } from '@stack/shared';

import { spawnGit } from './git-reference.js';
import {
  buildReviewArtifactFiles,
  materializeExactRevision,
  DEFAULT_REVIEW_BOUNDS,
} from './skill-check.js';

const file = (relativePath: string, content: string): SkillTreeEntry => ({
  relativePath,
  type: 'file',
  content: Buffer.from(content),
});

describe('buildReviewArtifactFiles', () => {
  it('classifies an added text file with afterText only', () => {
    const result = buildReviewArtifactFiles(
      [],
      [file('new.md', 'hello')],
      DEFAULT_REVIEW_BOUNDS,
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files).toEqual([
      {
        relativePath: 'new.md',
        kind: 'added',
        binary: false,
        after: { byteSize: 5, hash: expect.stringMatching(/^sha256:/) },
        afterText: 'hello',
      },
    ]);
  });
  it('classifies a removed text file with beforeText only', () => {
    const result = buildReviewArtifactFiles(
      [file('old.md', 'bye')],
      [],
      DEFAULT_REVIEW_BOUNDS,
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files[0]).toMatchObject({ kind: 'removed', beforeText: 'bye' });
    expect(result.files[0]?.afterText).toBeUndefined();
  });
  it('classifies a modified text file with both before and after', () => {
    const result = buildReviewArtifactFiles(
      [file('SKILL.md', 'old body')],
      [file('SKILL.md', 'new body')],
      DEFAULT_REVIEW_BOUNDS,
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files[0]).toMatchObject({
      kind: 'modified',
      beforeText: 'old body',
      afterText: 'new body',
    });
  });
  it('classifies a binary file change with no text content, only size+hash', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const result = buildReviewArtifactFiles(
      [{ relativePath: 'a.png', type: 'file', content: png }],
      [{ relativePath: 'a.png', type: 'file', content: Buffer.concat([png, Buffer.from([1])]) }],
      DEFAULT_REVIEW_BOUNDS,
    );
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files[0]?.binary).toBe(true);
    expect(result.files[0]?.beforeText).toBeUndefined();
    expect(result.files[0]?.afterText).toBeUndefined();
    expect(result.files[0]?.before?.byteSize).toBe(png.length);
  });
  it('returns unchanged files omitted entirely', () => {
    const same = file('x.md', 'same');
    const result = buildReviewArtifactFiles([same], [same], DEFAULT_REVIEW_BOUNDS);
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files).toHaveLength(0);
  });
  it('exceeds-bounds when total bytes exceed the cap', () => {
    const huge = 'x'.repeat(DEFAULT_REVIEW_BOUNDS.maxTotalBytes + 1);
    const result = buildReviewArtifactFiles([], [file('big.md', huge)], DEFAULT_REVIEW_BOUNDS);
    expect(result.status).toBe('exceeds-bounds');
  });
  it('exceeds-bounds when file count exceeds the cap', () => {
    const many = Array.from({ length: DEFAULT_REVIEW_BOUNDS.maxFiles + 1 }, (_, i) =>
      file(`f${i}.md`, 'x'),
    );
    const result = buildReviewArtifactFiles([], many, DEFAULT_REVIEW_BOUNDS);
    expect(result.status).toBe('exceeds-bounds');
  });
  it('exceeds-bounds when one file exceeds the per-file cap, even if total is small', () => {
    const big = 'x'.repeat(DEFAULT_REVIEW_BOUNDS.maxSingleFileBytes + 1);
    const result = buildReviewArtifactFiles(
      [],
      [file('one-big.md', big)],
      { ...DEFAULT_REVIEW_BOUNDS, maxTotalBytes: DEFAULT_REVIEW_BOUNDS.maxSingleFileBytes + 1024 },
    );
    expect(result.status).toBe('exceeds-bounds');
  });
});

describe('materializeExactRevision (real git fixture, local only)', () => {
  let repoDir: string;
  let workRoot: string;

  const run = async (cwd: string, args: string[]) => {
    const result = await spawnGit(args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    return result;
  };

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), 'stak-skillcheck-repo-'));
    workRoot = await mkdtemp(path.join(os.tmpdir(), 'stak-skillcheck-work-'));
    await run(repoDir, ['init', '-q']);
    await run(repoDir, ['config', 'user.email', 'test@example.com']);
    await run(repoDir, ['config', 'user.name', 'Test']);
    await mkdir(path.join(repoDir, 'my-skill'), { recursive: true });
    await writeFile(path.join(repoDir, 'my-skill', 'SKILL.md'), '# v1\n');
    await run(repoDir, ['add', '.']);
    await run(repoDir, ['commit', '-q', '-m', 'v1']);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(workRoot, { recursive: true, force: true });
  });

  it('fetches the exact revision\u2019s Skill subtree, never the moving HEAD', async () => {
    const first = await run(repoDir, ['rev-parse', 'HEAD']);
    const firstRevision = first.stdout.trim();
    // Advance the repo past the revision we're about to materialize.
    await writeFile(path.join(repoDir, 'my-skill', 'SKILL.md'), '# v2\n');
    await run(repoDir, ['add', '.']);
    await run(repoDir, ['commit', '-q', '-m', 'v2']);

    const entries = await materializeExactRevision({
      workRoot,
      remote: repoDir,
      revision: firstRevision,
      skillPath: 'my-skill',
    });
    const skillFile = entries.find((e) => e.relativePath === 'SKILL.md');
    expect(skillFile?.type).toBe('file');
    expect((skillFile as { content: Buffer }).content.toString()).toBe('# v1\n');
  });

  it('rejects a skill path that escapes the repository root', async () => {
    const head = (await run(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();
    await expect(
      materializeExactRevision({
        workRoot,
        remote: repoDir,
        revision: head,
        skillPath: '../../etc',
      }),
    ).rejects.toThrow();
  });

  it('cleans up its temp working directory even on failure', async () => {
    const before = (await import('node:fs/promises')).readdir;
    await expect(
      materializeExactRevision({
        workRoot,
        remote: repoDir,
        revision: 'not-a-real-revision',
        skillPath: 'my-skill',
      }),
    ).rejects.toThrow();
    const remaining = await before(workRoot);
    expect(remaining).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run src/skill-check.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// packages/core/src/skill-check.ts
import { createHash } from 'node:crypto';
import { mkdir, rm, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  enumerateSkillTree,
  hashSkillTreeEntries,
  type SkillTreeEntry,
} from '@stack/shared';

import { diffSkillTrees, type SkillTreeDiff } from './skill-source.js';
import { spawnGit, type GitExecutor } from './git-reference.js';

/* -------------------------------------------------------------------------- */
/* Ephemeral exact-revision materialization (P5a §1/§2 — LOCAL ONLY)           */
/* -------------------------------------------------------------------------- */

/**
 * Shallow-fetch ONE exact immutable revision's Skill subtree into a throwaway temp
 * directory, enumerate it, and clean up — never touches the content-addressed Store
 * (unlike `restoreReference`, which this intentionally does NOT reuse directly: that
 * function also ingests into the local Store, which neither side of a review diff needs).
 * Used for BOTH the approved side and the candidate side — both are independently
 * re-fetchable from the same remote by exact revision, so no Store/prior-restore
 * dependency is required. Runs with the user's own local Git auth; never executed from
 * Cloud.
 */
export const materializeExactRevision = async (options: {
  workRoot: string;
  remote: string;
  revision: string;
  skillPath: string;
  gitExecutor?: GitExecutor;
}): Promise<SkillTreeEntry[]> => {
  const git = options.gitExecutor ?? spawnGit;
  const workDir = path.join(options.workRoot, randomUUID());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ADVICE_DETACHED_HEAD: '0',
  };
  const run = async (args: string[]) => {
    const result = await git(args, { cwd: workDir, env });
    if (result.exitCode !== 0)
      throw new Error(
        `git ${args[0]} failed for ${options.remote}@${options.revision}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    return result;
  };
  try {
    await mkdir(workDir, { recursive: true });
    await run(['init', '-q']);
    await run(['remote', 'add', 'origin', options.remote]);
    await run(['fetch', '--depth', '1', 'origin', options.revision]);
    await run(['checkout', '-q', '--detach', 'FETCH_HEAD']);

    const normalizedSkillPath = options.skillPath.split('/').join(path.sep);
    const skillDir = path.resolve(workDir, normalizedSkillPath);
    const prefix = `${workDir}${path.sep}`;
    if (skillDir !== workDir && !skillDir.startsWith(prefix))
      throw new Error(`Skill path escapes the repository root: ${options.skillPath}`);
    try {
      await access(skillDir);
    } catch {
      throw new Error(`Skill path ${options.skillPath} is missing at this revision.`);
    }
    return await enumerateSkillTree(skillDir);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

/* -------------------------------------------------------------------------- */
/* Pure diff + bounds + binary classification (P5a §7/§8/§16)                  */
/* -------------------------------------------------------------------------- */

export type ReviewBounds = {
  maxFiles: number;
  maxTotalBytes: number;
  maxSingleFileBytes: number;
};
/** V0 bounds, frozen in the plan's Global Constraints. */
export const DEFAULT_REVIEW_BOUNDS: ReviewBounds = {
  maxFiles: 200,
  maxTotalBytes: 2 * 1024 * 1024,
  maxSingleFileBytes: 256 * 1024,
};

export type ReviewFileSide = { byteSize: number; hash: string };
export type ReviewArtifactFileRecord = {
  relativePath: string;
  kind: 'added' | 'modified' | 'removed';
  binary: boolean;
  before?: ReviewFileSide;
  after?: ReviewFileSide;
  beforeText?: string;
  afterText?: string;
};
export type ReviewArtifactFilesResult =
  | { status: 'ok'; files: ReviewArtifactFileRecord[] }
  | { status: 'exceeds-bounds' };

/** Heuristic binary classification: a NUL byte in the first 8000 bytes means binary — the
 *  same simple, well-established heuristic Git itself uses, not a MIME/extension guess. */
const isBinary = (content: Buffer): boolean =>
  content.subarray(0, 8000).includes(0);

const sideOf = (content: Buffer): ReviewFileSide => ({
  byteSize: content.length,
  hash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
});

/**
 * Pure: given the two already-materialized trees, compute the bounded review-artifact file
 * list. Reuses `diffSkillTrees` (P2) for the added/modified/removed classification — never
 * reimplements tree diffing. Enforces all three V0 bounds BEFORE producing any output: if any
 * bound is exceeded, no partial/truncated artifact is ever returned (contract §5a/§16).
 */
export const buildReviewArtifactFiles = (
  approved: SkillTreeEntry[],
  candidate: SkillTreeEntry[],
  bounds: ReviewBounds,
): ReviewArtifactFilesResult => {
  const diff: SkillTreeDiff = diffSkillTrees(approved, candidate);
  if (diff.files.length > bounds.maxFiles) return { status: 'exceeds-bounds' };

  const approvedByPath = new Map(
    approved
      .filter((e): e is SkillTreeEntry & { type: 'file' } => e.type === 'file')
      .map((e) => [e.relativePath, e.content]),
  );
  const candidateByPath = new Map(
    candidate
      .filter((e): e is SkillTreeEntry & { type: 'file' } => e.type === 'file')
      .map((e) => [e.relativePath, e.content]),
  );

  let totalBytes = 0;
  const files: ReviewArtifactFileRecord[] = [];
  for (const change of diff.files) {
    const beforeContent = approvedByPath.get(change.relativePath);
    const afterContent = candidateByPath.get(change.relativePath);
    const relevantBytes = [beforeContent, afterContent].filter(Boolean) as Buffer[];
    for (const b of relevantBytes)
      if (b.length > bounds.maxSingleFileBytes) return { status: 'exceeds-bounds' };
    totalBytes += relevantBytes.reduce((sum, b) => sum + b.length, 0);
    if (totalBytes > bounds.maxTotalBytes) return { status: 'exceeds-bounds' };

    const binary = relevantBytes.some(isBinary);
    const record: ReviewArtifactFileRecord = {
      relativePath: change.relativePath,
      kind: change.kind,
      binary,
      ...(beforeContent
        ? { before: sideOf(beforeContent), ...(binary ? {} : { beforeText: beforeContent.toString('utf8') }) }
        : {}),
      ...(afterContent
        ? { after: sideOf(afterContent), ...(binary ? {} : { afterText: afterContent.toString('utf8') }) }
        : {}),
    };
    files.push(record);
  }
  return { status: 'ok', files };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/skill-check.test.ts`
Expected: PASS (all cases, including the real-git-fixture tests — these use a local filesystem
repository via `git init`/shallow self-fetch, never any network)

- [ ] **Step 5: Run the package's typecheck + full test suite to confirm no regression**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/skill-check.ts packages/core/src/skill-check.test.ts
git commit -m "feat(p5a): local exact-revision materialization + bounded review diff"
```

---

### Task 6: Cloud-server product-service rewrite (read model + upload + approve-by-artifact)

**Files:**
- Modify: `packages/cloud-server/src/product-service.ts`
- Modify: `packages/cloud-server/src/service.ts` (remove the dead `checkSkillSource` config option)
- Modify: `packages/cloud-server/src/handler.ts` (new route; approve route's body shape)
- Modify: `packages/cloud-server/src/product.test.ts`
- Modify: `packages/cloud-server/src/errors.ts` if a new error code is needed (e.g.
  `review-artifact-stale`, `review-artifact-not-found`) — check first whether `notFound`/
  `invalidRequest`/`remoteConflict` already cover these with an appropriate `code` argument before
  adding a new helper.

**Interfaces:**
- Consumes: `SkillReviewCheckRecord` (Task 3); `UploadSkillReviewArtifactRequest`,
  `ReportSkillSourceCheckRequest`, `ApproveSkillVersionRequest`, `SkillSummary`, `SkillDetail`,
  `SkillReviewArtifact` (Task 1); `config.blobStore` (existing `CloudBlobStore`).
- Produces: `uploadSkillReviewArtifact(user, request): Promise<UploadSkillReviewArtifactResponse>`,
  `reportSkillSourceCheck(user, request): Promise<{ ok: true }>`, rewritten `getSkillsReadModel`,
  `getSkillDetail`, `approveSkillVersion`.

This is the largest task in the plan — work through it in the sub-steps below rather than as one
giant diff.

- [ ] **Step 1: Write the failing tests for the read model (no artifact dependency yet)**

```typescript
// Add to packages/cloud-server/src/product.test.ts
describe('Skills read model — P5a source-check states', () => {
  it('reports not-checked when no check has ever been stored', async () => {
    const env = setup(); // existing helper that seeds one approved Skill
    const result = await env.service.getSkillsReadModel(env.user);
    expect(result.skills[0]?.sourceCheckState).toBe('not-checked');
    expect(result.skills[0]?.checkedAt).toBeNull();
  });
  it('reports no-update from a stored report', async () => {
    const env = setup();
    await env.repository.putSkillReviewCheck({
      userId: env.user.userId,
      skillId: env.skillId,
      approvedContentHash: env.approvedContentHash,
      sourceCheckState: 'no-update',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    const result = await env.service.getSkillsReadModel(env.user);
    expect(result.skills[0]?.sourceCheckState).toBe('no-update');
    expect(result.skills[0]?.checkedAt).toBe('2026-01-01T00:00:00.000Z');
  });
  it('a stored check against a STALE approved base is ignored — reports not-checked', async () => {
    const env = setup();
    await env.repository.putSkillReviewCheck({
      userId: env.user.userId,
      skillId: env.skillId,
      approvedContentHash: 'sha256:' + 'f'.repeat(64), // not the current approved hash
      sourceCheckState: 'no-update',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    const result = await env.service.getSkillsReadModel(env.user);
    expect(result.skills[0]?.sourceCheckState).toBe('not-checked');
  });
  it('cannot-check reports its reason, distinct from not-checked', async () => {
    const env = setup();
    await env.repository.putSkillReviewCheck({
      userId: env.user.userId,
      skillId: env.skillId,
      approvedContentHash: env.approvedContentHash,
      sourceCheckState: 'cannot-check',
      cannotCheckReason: 'local',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    const result = await env.service.getSkillsReadModel(env.user);
    expect(result.skills[0]?.sourceCheckState).toBe('cannot-check');
    expect(result.skills[0]?.cannotCheckReason).toBe('local');
  });
  it('check-failed reports a sanitized reason', async () => {
    const env = setup();
    await env.repository.putSkillReviewCheck({
      userId: env.user.userId,
      skillId: env.skillId,
      approvedContentHash: env.approvedContentHash,
      sourceCheckState: 'check-failed',
      checkFailedReason: 'Network unreachable',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    const result = await env.service.getSkillsReadModel(env.user);
    expect(result.skills[0]?.sourceCheckState).toBe('check-failed');
    expect(result.skills[0]?.checkFailedReason).toBe('Network unreachable');
  });
});
```

Note: `setup()` in the existing `product.test.ts` already creates a user + environment + Skill; look at
how `checkSkillSource` was previously injected in `setup(options)` (lines ~97-113 per the earlier audit)
and remove/replace that option entirely — it no longer exists in `ProductServiceConfig`. If `setup()`
needs a new helper for conveniently getting the seeded Skill's `approvedContentHash`/`skillId` onto the
returned `env`, add it minimally (expose what the existing seed already computed, don't duplicate the
seeding logic).

- [ ] **Step 2: Run to verify failure, then implement the read-model half**

Run: `cd packages/cloud-server && npx vitest run src/product.test.ts` → FAIL (old shape).

In `product-service.ts`:
1. Remove `checkSkillSource` entirely: the `SourceLatest`/`SkillSourceChecker` type exports, the
   `checkSkillSource?:` config field, and the `if (config.checkSkillSource) { ... }` branch inside
   `skillSummaries()`.
2. Replace that branch with:

```typescript
  const skillSummaries = async (userId: string): Promise<SkillSummary[]> => {
    const current = await latestBundle(userId);
    if (!current) return [];
    const machines = await config.repository.listMachineStates(userId);
    const installsBySkill = new Map<string, SkillInstall[]>();
    for (const machine of machines)
      for (const skill of machine.skills) {
        const list = installsBySkill.get(skill.skillId) ?? [];
        list.push({
          machineId: machine.machineId,
          ...(machine.name !== undefined ? { name: machine.name } : {}),
          installedVersion: skill.installedVersion,
        });
        installsBySkill.set(skill.skillId, list);
      }
    const result: SkillSummary[] = [];
    for (const [skillId, skill] of Object.entries(current.bundle.resolved.skills)) {
      const stored = await config.repository.getSkillReviewCheck(userId, skillId);
      // A stored check only counts while it's computed against the CURRENT approved base
      // (contract §5a "base-bound results") — a stale one reads as not-checked, never as a
      // diff against the wrong base.
      const current_ =
        stored && stored.approvedContentHash === skill.contentHash ? stored : null;
      result.push({
        skillId,
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        approvedVersion: skill.contentHash,
        paused: skill.paused === true,
        source: sourceSummaryOf(skill),
        capability: capabilityStateOf(skill),
        sourceCheckState: current_?.sourceCheckState ?? 'not-checked',
        checkedAt: current_?.checkedAt ?? null,
        ...(current_?.candidateRevision ? { candidateRevision: current_.candidateRevision } : {}),
        ...(current_?.reviewArtifactId ? { reviewArtifactId: current_.reviewArtifactId } : {}),
        ...(current_?.cannotCheckReason ? { cannotCheckReason: current_.cannotCheckReason } : {}),
        ...(current_?.checkFailedReason ? { checkFailedReason: current_.checkFailedReason } : {}),
        installs: installsBySkill.get(skillId) ?? [],
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  };
```

Remove the `ProductServiceConfig.checkSkillSource` field. Remove the `SourceLatest`/`SkillSourceChecker`
type exports from this file (they're dead now that nothing produces or consumes them). In
`service.ts`, remove the corresponding `checkSkillSource` passthrough (the `...(config.checkSkillSource
? { checkSkillSource: config.checkSkillSource } : {})` block and its type import).

- [ ] **Step 3: Run to verify the read-model tests pass**

Run: `cd packages/cloud-server && npx vitest run src/product.test.ts`
Expected: the new tests from Step 1 PASS; existing tests that referenced the old `updateStatus`/
`candidateVersion` fields will now fail — fix those assertions in the same pass (update them to the
new field names; do not delete coverage, translate it).

- [ ] **Step 4: Write the failing tests for `uploadSkillReviewArtifact`/`reportSkillSourceCheck`**

```typescript
describe('uploadSkillReviewArtifact', () => {
  it('stores the artifact metadata + blob and the Skill reads back update-available', async () => {
    const env = setup();
    const files = [
      { relativePath: 'SKILL.md', kind: 'modified' as const, binary: false },
    ];
    const payload = Buffer.from(JSON.stringify({ files: [{ relativePath: 'SKILL.md', afterText: 'x' }] }));
    const artifactPayloadHash = 'sha256:' + require('node:crypto').createHash('sha256').update(payload).digest('hex');
    const result = await env.service.uploadSkillReviewArtifact(env.user, {
      skillId: env.skillId,
      approvedContentHash: env.approvedContentHash,
      candidateRevision: 'abc123',
      candidateContentHash: 'sha256:' + 'b'.repeat(64),
      artifactPayloadHash,
      checkedAt: '2026-01-01T00:00:00.000Z',
      files,
    }, payload);
    expect(result.reviewArtifactId).toBeDefined();
    const detail = await env.service.getSkillDetail(env.user, env.skillId);
    expect(detail.sourceCheckState).toBe('update-available');
    expect(detail.reviewArtifact?.reviewArtifactId).toBe(result.reviewArtifactId);
  });
  it('rejects a payload whose hash does not match the declared artifactPayloadHash', async () => {
    const env = setup();
    await expect(
      env.service.uploadSkillReviewArtifact(
        env.user,
        {
          skillId: env.skillId,
          approvedContentHash: env.approvedContentHash,
          candidateRevision: 'abc123',
          candidateContentHash: 'sha256:' + 'b'.repeat(64),
          artifactPayloadHash: 'sha256:' + '0'.repeat(64),
          checkedAt: '2026-01-01T00:00:00.000Z',
          files: [],
        },
        Buffer.from('not matching'),
      ),
    ).rejects.toThrow();
  });
  it('rejects more than 200 files or more than the byte bound (schema-level, covered in Task 1 — here assert the service enforces it defensively too if the schema bound were bypassed)', async () => {
    // Intentionally light here — the hard bound is enforced at the schema layer (Task 1). This
    // test exists only to confirm the service does not ALSO silently accept an empty/absurd
    // payload that technically parses.
  });
  it('a NEW upload replaces the prior artifact — old blob becomes unreachable, metadata shows only the new one', async () => {
    const env = setup();
    const first = await env.service.uploadSkillReviewArtifact(env.user, { /* ...A... */ }, Buffer.from('a'));
    const second = await env.service.uploadSkillReviewArtifact(env.user, { /* ...B... */ }, Buffer.from('b'));
    const detail = await env.service.getSkillDetail(env.user, env.skillId);
    expect(detail.reviewArtifact?.reviewArtifactId).toBe(second.reviewArtifactId);
    expect(detail.reviewArtifact?.reviewArtifactId).not.toBe(first.reviewArtifactId);
  });
});

describe('reportSkillSourceCheck', () => {
  it('stores a no-update report with no artifact', async () => {
    const env = setup();
    await env.service.reportSkillSourceCheck(env.user, {
      skillId: env.skillId,
      approvedContentHash: env.approvedContentHash,
      sourceCheckState: 'no-update',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    const detail = await env.service.getSkillDetail(env.user, env.skillId);
    expect(detail.sourceCheckState).toBe('no-update');
    expect(detail.reviewArtifact).toBeNull();
  });
});
```

- [ ] **Step 5: Implement `uploadSkillReviewArtifact`/`reportSkillSourceCheck`**

```typescript
    uploadSkillReviewArtifact: async (
      user: AuthenticatedUser,
      request: UploadSkillReviewArtifactRequest,
      payloadBytes: Uint8Array,
    ): Promise<UploadSkillReviewArtifactResponse> => {
      const actualHash = `sha256:${createHash('sha256').update(payloadBytes).digest('hex')}`;
      if (actualHash !== request.artifactPayloadHash)
        throw invalidRequest('Uploaded review payload does not match its declared hash.');
      const current = await latestBundle(user.userId);
      const skill = current?.bundle.resolved.skills[request.skillId];
      if (!skill) throw notFound('skill-not-found', 'No such Skill.');
      const reviewArtifactId = config.newId();
      // Metadata commits BEFORE the old blob is removed (contract §5a "safe replacement").
      await config.blobStore.put(user.userId, request.artifactPayloadHash, payloadBytes);
      const previous = await config.repository.getSkillReviewCheck(user.userId, request.skillId);
      await config.repository.putSkillReviewCheck({
        userId: user.userId,
        skillId: request.skillId,
        approvedContentHash: request.approvedContentHash,
        sourceCheckState: 'update-available',
        checkedAt: request.checkedAt,
        candidateRevision: request.candidateRevision,
        candidateContentHash: request.candidateContentHash,
        reviewArtifactId,
        artifactPayloadHash: request.artifactPayloadHash,
        diffFiles: request.files.map((f) => ({
          relativePath: f.relativePath,
          kind: f.kind,
          binary: f.binary,
          ...(f.before ? { before: f.before } : {}),
          ...(f.after ? { after: f.after } : {}),
        })),
      });
      if (previous?.artifactPayloadHash && previous.artifactPayloadHash !== request.artifactPayloadHash)
        // Best-effort: the new metadata is already committed and authoritative even if this
        // cleanup fails; a dangling old blob is harmless (content-addressed, owner-scoped).
        await config.blobStore
          .put(user.userId, previous.artifactPayloadHash, new Uint8Array())
          .catch(() => undefined);
      return { reviewArtifactId };
    },

    reportSkillSourceCheck: async (
      user: AuthenticatedUser,
      request: ReportSkillSourceCheckRequest,
    ): Promise<{ ok: true }> => {
      const current = await latestBundle(user.userId);
      const skill = current?.bundle.resolved.skills[request.skillId];
      if (!skill) throw notFound('skill-not-found', 'No such Skill.');
      await config.repository.putSkillReviewCheck({
        userId: user.userId,
        skillId: request.skillId,
        approvedContentHash: request.approvedContentHash,
        sourceCheckState: request.sourceCheckState,
        checkedAt: request.checkedAt,
        ...(request.cannotCheckReason ? { cannotCheckReason: request.cannotCheckReason } : {}),
        ...(request.failureReason ? { checkFailedReason: request.failureReason } : {}),
      });
      return { ok: true };
    },
```

Revisit the "old blob cleanup" line above during implementation: `CloudBlobStore` has no `delete`
method today (only `putPending`/`getPending`/`deletePending`/`put`/`get`/`has`). Either (a) add a
`delete(userId, contentHash)` method to `CloudBlobStore` (both the interface and every implementation:
in-memory in `memory.ts`, Supabase in `apps/web/lib/blob.ts`) and call that instead of the
`put(..., new Uint8Array())` placeholder above, or (b) accept that old blobs are simply
content-addressed, owner-scoped, and unreferenced once superseded (never served by any read path) and
skip physical deletion for V0, relying only on the metadata row no longer pointing at them. **Prefer
(b)** unless the Task 6 implementer judges the extra `delete` method trivial and clearly
worth it — this is a legitimate judgment call to make during implementation, not before; note the
choice and reasoning in the task report either way.

`getSkillDetail` needs the artifact's full content merged in when present:

```typescript
    getSkillDetail: async (
      user: AuthenticatedUser,
      skillId: string,
    ): Promise<SkillDetail> => {
      const summaries = await skillSummaries(user.userId);
      const summary = summaries.find((s) => s.skillId === skillId);
      if (!summary) throw notFound('skill-not-found', 'No such Skill.');
      const versions = await config.repository.listEnvironmentVersions(user.userId, 'main');
      const seen = new Set<string>();
      const history = versions
        .map((version) => ({
          contentHash: version.bundle.resolved.skills[skillId]?.contentHash,
          environmentVersionNumber: version.versionNumber,
          approvedAt: version.createdAt,
        }))
        .filter((entry): entry is NonNullable<typeof entry> & { contentHash: string } =>
          entry.contentHash !== undefined,
        )
        .filter((entry) => {
          if (seen.has(entry.contentHash)) return false;
          seen.add(entry.contentHash);
          return true;
        });
      let reviewArtifact: SkillDetail['reviewArtifact'] = null;
      if (summary.sourceCheckState === 'update-available' && summary.reviewArtifactId) {
        const stored = await config.repository.getSkillReviewCheck(user.userId, skillId);
        if (stored?.artifactPayloadHash) {
          const bytes = await config.blobStore.get(user.userId, stored.artifactPayloadHash);
          const payload = bytes ? JSON.parse(Buffer.from(bytes).toString('utf8')) : { files: [] };
          const textByPath = new Map<string, { beforeText?: string; afterText?: string }>(
            (payload.files ?? []).map((f: any) => [f.relativePath, f]),
          );
          reviewArtifact = {
            reviewArtifactId: stored.reviewArtifactId!,
            skillId,
            approvedContentHash: stored.approvedContentHash,
            candidateRevision: stored.candidateRevision!,
            candidateContentHash: stored.candidateContentHash!,
            artifactPayloadHash: stored.artifactPayloadHash,
            checkedAt: stored.checkedAt,
            files: (stored.diffFiles ?? []).map((f) => ({
              ...f,
              ...(textByPath.get(f.relativePath)?.beforeText !== undefined
                ? { beforeText: textByPath.get(f.relativePath)!.beforeText }
                : {}),
              ...(textByPath.get(f.relativePath)?.afterText !== undefined
                ? { afterText: textByPath.get(f.relativePath)!.afterText }
                : {}),
            })),
          };
        }
      }
      return { ...summary, history, reviewArtifact };
    },
```

- [ ] **Step 6: Run to verify the artifact tests pass**

Run: `cd packages/cloud-server && npx vitest run src/product.test.ts`
Expected: PASS

- [ ] **Step 7: Write the failing tests for approve-by-artifact + stale/superseded + the frozen
  "upstream moved without recheck remains approvable" case**

```typescript
describe('approveSkillVersion — by artifact (P5a)', () => {
  it('approves the exact candidate recorded in the current artifact', async () => {
    const env = setup();
    const { reviewArtifactId } = await env.service.uploadSkillReviewArtifact(env.user, { /* A */ }, Buffer.from('a'));
    const result = await env.service.approveSkillVersion(env.user, {
      skillId: env.skillId,
      reviewArtifactId,
    });
    expect(result.changed).toBe(true);
  });
  it('rejects an artifact that belongs to a different account', async () => {
    const env = setup();
    const other = await setupSecondUser(); // follow whatever helper the test file already uses for a 2nd user
    const { reviewArtifactId } = await env.service.uploadSkillReviewArtifact(env.user, { /* A */ }, Buffer.from('a'));
    await expect(
      other.service.approveSkillVersion(other.user, { skillId: env.skillId, reviewArtifactId }),
    ).rejects.toThrow();
  });
  it('rejects an artifact id for the wrong Skill', async () => {
    const env = setupWithTwoSkills(); // or construct inline if no such helper exists yet
    const { reviewArtifactId } = await env.service.uploadSkillReviewArtifact(env.user, { skillId: env.skillIdA, /* ... */ }, Buffer.from('a'));
    await expect(
      env.service.approveSkillVersion(env.user, { skillId: env.skillIdB, reviewArtifactId }),
    ).rejects.toThrow();
  });
  it('CASE B: a newer artifact supersedes an older one — approving the old id is rejected', async () => {
    const env = setup();
    const a = await env.service.uploadSkillReviewArtifact(env.user, { /* revision A */ }, Buffer.from('a'));
    const b = await env.service.uploadSkillReviewArtifact(env.user, { /* revision B, same skill */ }, Buffer.from('b'));
    await expect(
      env.service.approveSkillVersion(env.user, { skillId: env.skillId, reviewArtifactId: a.reviewArtifactId }),
    ).rejects.toThrow();
    const result = await env.service.approveSkillVersion(env.user, { skillId: env.skillId, reviewArtifactId: b.reviewArtifactId });
    expect(result.changed).toBe(true);
  });
  it('CASE C: approved base changes before the artifact is approved — the old artifact is rejected', async () => {
    const env = setup();
    const a = await env.service.uploadSkillReviewArtifact(env.user, { /* ... */ }, Buffer.from('a'));
    // Simulate an unrelated approval of a DIFFERENT candidate that changes the approved base.
    await env.service.approveSkillVersion(env.user, { skillId: env.skillId, reviewArtifactId: a.reviewArtifactId });
    // a's own approval already consumed it; craft a second artifact A2 against the ORIGINAL base,
    // then approve something else that moves the base again, then assert A2 is now rejected.
    // (Implementer: construct this precisely against whatever `setup()` exposes — the key
    // assertion is: artifact.approvedContentHash !== current Skill.approvedContentHash => reject.)
  });
  it('UPSTREAM-MOVED-WITHOUT-RECHECK: artifact A remains approvable even after a (mocked/no-op) \u201cupstream moved to B\u201d — Cloud never re-resolves upstream at approval time', async () => {
    const env = setup();
    const a = await env.service.uploadSkillReviewArtifact(env.user, { /* revision A */ }, Buffer.from('a'));
    // No new stak skill check ran — nothing in this test simulates upstream moving, because
    // Cloud has no mechanism to observe it. The assertion IS the absence of any re-resolution:
    // approving A succeeds using only A's own stored, already-committed data.
    const result = await env.service.approveSkillVersion(env.user, {
      skillId: env.skillId,
      reviewArtifactId: a.reviewArtifactId,
    });
    expect(result.changed).toBe(true);
  });
  it('approval is idempotent for the same artifact', async () => {
    const env = setup();
    const a = await env.service.uploadSkillReviewArtifact(env.user, { /* ... */ }, Buffer.from('a'));
    const first = await env.service.approveSkillVersion(env.user, { skillId: env.skillId, reviewArtifactId: a.reviewArtifactId });
    expect(first.changed).toBe(true);
  });
});
```

Fill in the `{ /* ... */ }` placeholders with concrete, internally-consistent
`UploadSkillReviewArtifactRequest` objects when implementing — the plan leaves them abbreviated only
to keep this brief readable; every actual test you write must have complete, valid request bodies (no
placeholder values committed to the test file itself).

- [ ] **Step 8: Implement `approveSkillVersion`**

```typescript
    approveSkillVersion: async (
      user: AuthenticatedUser,
      request: ApproveSkillVersionRequest,
    ) => {
      const current = await latestBundle(user.userId);
      if (!current)
        throw notFound('remote-environment-not-found', 'No cloud Environment.');
      const skill = current.bundle.resolved.skills[request.skillId];
      if (!skill) throw notFound('skill-not-found', 'No such Skill.');
      const stored = await config.repository.getSkillReviewCheck(user.userId, request.skillId);
      if (
        !stored ||
        stored.reviewArtifactId !== request.reviewArtifactId ||
        stored.sourceCheckState !== 'update-available'
      )
        throw remoteConflict(
          'This review is no longer current. A newer check has superseded it — review again.',
        );
      if (stored.approvedContentHash !== skill.contentHash)
        throw remoteConflict(
          'The approved version changed since this review was created. Review again.',
        );
      const candidateContentHash = stored.candidateContentHash!;
      const candidateRevision = stored.candidateRevision!;
      if (skill.restoration.strategy !== 'reference')
        throw invalidRequest('This Skill has no checkable source to approve a version from.');
      if (skill.contentHash === candidateContentHash)
        return { skillId: request.skillId, approvedVersion: skill.contentHash, createdNew: false };
      const nextSkill: PortableLockedSkill = {
        ...skill,
        contentHash: candidateContentHash,
        restoration: {
          strategy: 'reference',
          reference: {
            ...skill.restoration.reference,
            revision: candidateRevision,
            expectedContentHash: candidateContentHash,
          },
        },
      };
      const approvedVersion = await commitBundleMutation(user.userId, current, {
        [request.skillId]: nextSkill,
      });
      // The artifact described a delta that no longer applies now that it's approved —
      // invalidate immediately (contract §5a "base-bound results").
      await config.repository.deleteSkillReviewCheck(user.userId, request.skillId);
      return {
        skillId: request.skillId,
        approvedVersion: candidateContentHash,
        createdNew: true,
        environmentVersionNumber: approvedVersion.versionNumber,
      };
    },
```

Check whether `remoteConflict` (imported from `./errors.js`) already exists with a 2-argument
`(message, ...)` shape matching this usage — the earlier audit saw it imported in this file already;
confirm its exact signature before using it, and adjust the calls above if it takes different
arguments (e.g. a `code` parameter).

- [ ] **Step 9: Run to verify all approve-by-artifact tests pass**

Run: `cd packages/cloud-server && npx vitest run src/product.test.ts`
Expected: PASS

- [ ] **Step 10: Add the HTTP route (for CLI access via `cloud-client`/`handler.ts`)**

In `handler.ts`, add near the existing `skills/:id/approve` route:

```typescript
    if (
      method === 'POST' &&
      segments.length === 3 &&
      segments[0] === 'skills' &&
      segments[2] === 'review-check'
    ) {
      const user = await authenticate();
      const body = reportSkillSourceCheckRequestSchema.parse({
        skillId: segments[1],
        ...(typeof request.jsonBody === 'object' && request.jsonBody ? request.jsonBody : {}),
      });
      return json(200, await service.reportSkillSourceCheck(user, body));
    }
    if (
      method === 'POST' &&
      segments.length === 3 &&
      segments[0] === 'skills' &&
      segments[2] === 'review-artifact'
    ) {
      const user = await authenticate();
      const body = uploadSkillReviewArtifactRequestSchema.parse({
        skillId: segments[1],
        ...(typeof request.jsonBody === 'object' && request.jsonBody ? request.jsonBody : {}),
      });
      // The artifact's bounded text payload travels as `request.binaryBody` — the CloudRequest
      // type already supports this (used by the existing snapshot-upload route; follow that
      // route's exact pattern for extracting binaryBody here).
      return json(
        200,
        await service.uploadSkillReviewArtifact(user, body, request.binaryBody ?? new Uint8Array()),
      );
    }
```

Update the existing `skills/:id/approve` route's body parse to use the new
`approveSkillVersionRequestSchema` shape (it already does via the schema import — just confirm the
`...request.jsonBody` spread now only ever carries `reviewArtifactId`, nothing else, since the schema
is `.strict()`).

- [ ] **Step 11: Run cloud-server's full suite + typecheck**

Run: `cd packages/cloud-server && npx tsc --noEmit && npx vitest run`
Expected: PASS, zero regressions outside the intentional field-name translations from Step 3.

- [ ] **Step 12: Commit**

```bash
git add packages/cloud-server/src/product-service.ts packages/cloud-server/src/service.ts \
        packages/cloud-server/src/handler.ts packages/cloud-server/src/product.test.ts \
        packages/cloud-server/src/errors.ts
git commit -m "feat(p5a): persisted source-check read model + approve-by-artifact"
```

---

### Task 7: `cloud-client` methods

**Files:**
- Modify: `packages/cloud-client/src/client.ts`
- Modify: its corresponding test file (find the existing one — likely
  `packages/cloud-client/src/client.test.ts`)

**Interfaces:**
- Produces: `reportSkillSourceCheck(request)`, `uploadSkillReviewArtifact(request, payloadBytes)`
  client methods calling the two new routes from Task 6; the existing `approveSkillVersion` client
  call updated to send `{ skillId, reviewArtifactId }`.

- [ ] **Step 1: Find and read the existing approve-skill client call + one existing binary-upload
  client call (e.g. the snapshot upload) to match the file's exact fetch/auth-header/error-handling
  conventions** before writing anything — this file was not fully read during planning; do not guess
  its HTTP client shape.

- [ ] **Step 2: Write failing tests** mirroring whatever pattern the existing client test file uses for
  a POST-with-JSON-body call and a POST-with-binary-body call (follow its fixture/mock-fetch
  conventions exactly — this plan cannot specify the exact test code without having read that file
  first; the implementer must read it as this step).

- [ ] **Step 3: Implement the two new methods + update the approve call**, following the file's
  existing method shapes exactly (same error-wrapping, same base-URL/auth-header construction).

- [ ] **Step 4: Run the package's tests + typecheck**

Run: `cd packages/cloud-client && npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cloud-client/src/client.ts packages/cloud-client/src/client.test.ts
git commit -m "feat(p5a): cloud-client methods for review-check report/upload + approve-by-artifact"
```

---

### Task 8: CLI `stak skill check [<skill>]`

**Files:**
- Modify: `packages/cli/src/commands/skill.ts` (add the `check` subcommand to the existing `registerSkillCommand`)
- Create: `packages/cli/src/skill-check-runner.ts` (the orchestration: resolve → materialize both
  sides → diff → bound → upload/report; kept out of `commands/skill.ts` so the command file stays a
  thin CLI-parsing layer, matching how `skillUpdate`'s real logic lives in `program.ts`/elsewhere, not
  in `commands/skill.ts` itself)
- Create: `packages/cli/src/skill-check-runner.test.ts`
- Modify: `packages/cli/src/program.ts` (wire the real dependency, following the exact pattern
  `skillUpdate`/`skillPause`/`skillResume` already use at the lines read during planning)

**Interfaces:**
- Consumes: `resolveSkillSourceLatest`, `resolvePublicStackSourceLatest` (`packages/core/src/skill-source.ts`);
  `materializeExactRevision`, `buildReviewArtifactFiles`, `DEFAULT_REVIEW_BOUNDS`
  (`packages/core/src/skill-check.ts`, Task 5); `reportSkillSourceCheck`/`uploadSkillReviewArtifact`
  (`packages/cloud-client`, Task 7); `resolveSkillSelector` (existing, from `composition.js`).
- Produces: `runSkillCheck(options): Promise<SkillCheckResult>` where
  `SkillCheckResult = { checked: { entryId: string; name: string; outcome: 'no-update' |
  'update-available' | 'cannot-check' | 'check-failed' }[] }`; the registered `stak skill check
  [<skill>]` command.

- [ ] **Step 1: Write the failing tests** for `runSkillCheck`, using a local synthetic Git fixture
  repository (same `mkdtemp`/`git init` pattern as Task 5's tests) and a fake cloud-client (an object
  matching the two methods' signatures, recording calls instead of making network requests — this
  satisfies the Global Constraint against real uploads during tests):

```typescript
// packages/cli/src/skill-check-runner.test.ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { spawnGit } from '@stack/core';

import { runSkillCheck } from './skill-check-runner.js';

// (Set up a one-Skill lock with a git-reference restoration pointing at a local temp
// repository, mirroring whatever fixture helper `skill-lifecycle.test.ts` already uses for
// constructing a minimal EnvironmentLock with one reference-backed Skill — reuse it rather
// than hand-rolling a new one.)

describe('runSkillCheck', () => {
  it('reports no-update when the tracked ref still resolves to the approved revision', async () => {
    // Arrange: repo at revision R, lock's approved revision === R.
    // Act: runSkillCheck.
    // Assert: fake cloud-client's reportSkillSourceCheck called with sourceCheckState: 'no-update';
    //         uploadSkillReviewArtifact NOT called.
  });
  it('uploads a review artifact when the tracked ref has a newer revision', async () => {
    // Arrange: repo advances past the approved revision with a SKILL.md change.
    // Act, assert: fake cloud-client's uploadSkillReviewArtifact called once with files
    //              containing the SKILL.md change; candidateRevision === the new HEAD.
  });
  it('reports cannot-check for a Local-restoration Skill without materializing anything', async () => {
    // Assert: no git command attempted; reportSkillSourceCheck called with
    //         sourceCheckState: 'cannot-check', cannotCheckReason: 'local'.
  });
  it('reports check-failed, with a sanitized reason, when the remote is unreachable', async () => {
    // Use a remote path that doesn't exist. Assert reportSkillSourceCheck called with
    // sourceCheckState: 'check-failed' and a checkFailedReason that does NOT contain the raw
    // git stderr verbatim (sanitize: a short fixed phrase, not an interpolated error message
    // that could carry a credential-bearing URL).
  });
  it('reports update-available with NO artifact upload when bounds are exceeded', async () => {
    // Arrange a change exceeding DEFAULT_REVIEW_BOUNDS.maxSingleFileBytes.
    // Assert: reportSkillSourceCheck called with sourceCheckState such that the summary still
    //         communicates an update exists, but uploadSkillReviewArtifact is NOT called.
    //         (Implementer: decide the exact wire representation for this case during
    //         implementation — e.g. a reportSkillSourceCheck variant or a distinguishable
    //         upload-attempt rejection — and make it internally consistent with Task 6's
    //         service methods; if Task 6's schema doesn't yet support this exact case, that is
    //         a real gap to flag back to the controller, not to paper over.)
  });
  it('a selector checks only the named Skill', async () => { /* two-skill lock, selector narrows to one */ });
  it('with no selector, checks every checkable Skill', async () => { /* two-skill lock, no selector */ });
  it('never approves, installs, pauses, or resumes anything', async () => {
    // Assert the fake cloud-client exposes no approve/pause/install call at all (don't even
    // give the fake those methods, so a call would be a TypeError, not a silent no-op).
  });
});
```

Flag the "bounds exceeded" wire representation explicitly in your task report — this plan intends it
to work, but the precise schema needs one more decision at implementation time: either (a) add an
`exceedsReviewBounds: boolean` flag to `reportSkillSourceCheckRequestSchema`'s `sourceCheckState: 'update-available'`-shaped sibling (meaning `reportSkillSourceCheck` needs to additionally accept
`update-available` with a `candidateRevision` but no artifact, distinct from today's "upload an
artifact" path), or (b) treat it as `sourceCheckState: 'check-failed'` with a specific
`checkFailedReason` string like `"Update exceeds V0 review limits"`. **Prefer (a)** if it's a small,
additive schema change (go back and extend Task 1's `reportSkillSourceCheckRequestSchema`'s
`sourceCheckState` enum to include `'update-available'` with `candidateRevision` required and no
artifact fields, plus a corresponding small edit to Task 6's `reportSkillSourceCheck` service method
and the web's rendering in Task 10) rather than overloading `check-failed`'s meaning. This is the one
place in the plan where an earlier task's schema may need a small, additive follow-up edit — make it,
note it clearly in this task's report, and re-run Task 1's and Task 6's tests to confirm nothing
breaks.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && npx vitest run src/skill-check-runner.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `runSkillCheck`**

```typescript
// packages/cli/src/skill-check-runner.ts
import {
  resolveSkillSourceLatest,
  materializeExactRevision,
  buildReviewArtifactFiles,
  DEFAULT_REVIEW_BOUNDS,
} from '@stack/core';
import { resolveSkillSelector } from '@stack/core'; // or wherever it's actually exported from — confirm the real export path before writing this import
import type { EnvironmentLock } from '@stack/spec';

export type SkillCheckOutcome =
  | { outcome: 'no-update' }
  | { outcome: 'cannot-check'; reason: 'local' | 'dirty' | 'ambiguous' | 'unreachable' | 'pinned' }
  | { outcome: 'check-failed'; reason: string }
  | { outcome: 'update-available'; exceedsBounds: true }
  | { outcome: 'update-available'; exceedsBounds: false; reviewArtifactId: string };

export type SkillCheckReporter = {
  reportSkillSourceCheck(input: {
    skillId: string;
    approvedContentHash: string;
    sourceCheckState: 'no-update' | 'cannot-check' | 'check-failed' | 'update-available';
    checkedAt: string;
    cannotCheckReason?: string;
    failureReason?: string;
    candidateRevision?: string;
  }): Promise<void>;
  uploadSkillReviewArtifact(input: {
    skillId: string;
    approvedContentHash: string;
    candidateRevision: string;
    candidateContentHash: string;
    artifactPayloadHash: string;
    checkedAt: string;
    files: unknown[];
  }, payloadBytes: Uint8Array): Promise<{ reviewArtifactId: string }>;
};

export const runSkillCheck = async (options: {
  lock: EnvironmentLock;
  selector?: string;
  workRoot: string;
  reporter: SkillCheckReporter;
  now?: () => Date;
}): Promise<{ checked: { entryId: string; name: string; outcome: SkillCheckOutcome }[] }> => {
  // 1. Resolve the set of entryIds to check (one via resolveSkillSelector, or all).
  // 2. For each: call resolveSkillSourceLatest. 'same' -> no-update. 'uncheckable' -> cannot-check
  //    (map the reason; 'pinned' maps to 'pinned'). On a resolution throw -> check-failed with a
  //    SANITIZED fixed message (e.g. "Could not reach the source remote"), never the raw error.
  // 3. On 'different': materializeExactRevision for BOTH the approved revision and the candidate
  //    revision (same remote/path, two different revisions) via two calls.
  // 4. buildReviewArtifactFiles(approvedTree, candidateTree, DEFAULT_REVIEW_BOUNDS).
  //    - 'exceeds-bounds' -> report update-available with no artifact (per Step 1's decided wire shape).
  //    - 'ok' -> compute candidateContentHash via hashSkillTreeEntries(candidateTree), serialize the
  //      files' before/after TEXT content into one canonical JSON payload, hash it for
  //      artifactPayloadHash, call reporter.uploadSkillReviewArtifact with the metadata-only file
  //      list (no text) + the payload bytes separately.
  // 5. Collect per-Skill outcomes and return them; this function must never call anything
  //    resembling approve/pause/resume/install.
};
```

Write the real body during implementation, following the numbered steps above precisely — they are a
complete specification, not a summary; every branch is exact. Use `materializeExactRevision` twice per
checkable Skill with an update (once for `reference.revision` — the currently approved revision — and
once for the newly-resolved candidate revision), both against `reference.remote`/`reference.path`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && npx vitest run src/skill-check-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Register the CLI command**

In `packages/cli/src/commands/skill.ts`, add inside `registerSkillCommand`:

```typescript
  skill
    .command('check [skill]')
    .description('Check Skill sources for updates (contacts remotes; never approves/installs)')
    .option('--json', 'emit structured JSON only')
    .action(async (selector: string | undefined, options: { json?: boolean }) => {
      const result = await dependencies.skillCheck(selector ? { selector } : {});
      dependencies.writeOut(
        options.json ? `${JSON.stringify(result, null, 2)}\n` : renderCheck(result),
      );
    });
```

Add a `renderCheck(result)` function mirroring `renderUpdate`/`renderPaused`'s style (per-Skill lines:
"No update" / "Update available" / "Can't check for updates from this source" / "Check failed:
\<reason\>"), and add `skillCheck: (options: { selector?: string }) => Promise<SkillCheckResult>` to
`SkillCommandDependencies`.

In `program.ts`, wire the real dependency near `skillUpdate`/`skillPause`/`skillResume`:

```typescript
  skillCheck: async ({ selector }) => {
    const state = await loadMainEnvironment({ stackHome }).catch(() => null);
    if (!state) return { checked: [] };
    return runSkillCheck({
      lock: state.lock,
      ...(selector ? { selector } : {}),
      workRoot: path.join(stackHome, 'runtime', 'skill-check'),
      reporter: cloudClient, // the already-configured authenticated cloud-client instance
    });
  },
```

Confirm the exact shape of the already-configured cloud-client instance available in this file (it's
used elsewhere in `program.ts` for `push`/`pull`) before wiring this — do not construct a second,
differently-configured client.

- [ ] **Step 6: Run the CLI package's full suite + typecheck**

Run: `cd packages/cli && npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/skill.ts packages/cli/src/skill-check-runner.ts \
        packages/cli/src/skill-check-runner.test.ts packages/cli/src/program.ts
git commit -m "feat(p5a): stak skill check — local source resolution + review-artifact upload"
```

---

### Task 9: Local-apply hash-verification proof

**Files:**
- Create: `packages/adapters/src/skill-update-integrity.test.ts`

**Interfaces:**
- Consumes: whatever `applyBindings` entry point `codex.ts` (or the shared adapter logic) exposes,
  `materializeStoredSkill`/`ingestSkill` from `@stack/store`.

**Context:** the audit already found that `materializeStoredSkill` (used by the adapters' bind/apply
path per `codex.ts:475`) calls `verifyStoredSkill` internally, which re-hashes staged content and
throws `ContentHashMismatchError` on any mismatch — this is already covered at the Store unit-test
level (`packages/store/src/store.test.ts:146`). This task's job is narrower: prove the SAME fail-closed
behavior holds at the integration point `stak skill update` actually calls, not re-prove the Store
primitive.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/adapters/src/skill-update-integrity.test.ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ingestSkill, contentObjectPaths } from '@stack/store';

// Import whatever the real local-apply entry point is for one agent (codex, per the audit) —
// confirm the exact exported function name/signature by reading codex.ts around line 475
// before writing this import; the plan cannot name it precisely without that read.

describe('local apply — content-hash integrity (P5a §21 proof)', () => {
  let stackHome: string;
  beforeEach(async () => {
    stackHome = await mkdtemp(path.join(os.tmpdir(), 'stak-apply-integrity-'));
  });
  afterEach(async () => {
    await rm(stackHome, { recursive: true, force: true });
  });

  it('fails closed and projects NOTHING when the stored object has been corrupted on disk', async () => {
    // 1. Ingest a known-good Skill tree, getting its real contentHash.
    // 2. Corrupt the stored object's content on disk directly (e.g. overwrite one file's bytes
    //    in the store's content directory, bypassing ingestSkill).
    // 3. Call the real local-apply path (whatever applyBindings/materializeStoredSkill wiring
    //    `stak skill update` uses) for that Skill.
    // 4. Assert it throws/rejects (fails closed) — confirmed via the existing
    //    ContentHashMismatchError or equivalent — AND assert no file was written to the
    //    target projection directory (e.g. the target dir either doesn't exist or is empty),
    //    not just that an error was thrown.
  });
});
```

- [ ] **Step 2: Run to verify it fails or passes**

Run: `cd packages/adapters && npx vitest run src/skill-update-integrity.test.ts`

**This is the one step in the whole plan where PASS-on-first-run is an acceptable, expected outcome**
(not a TDD violation) — the audit already has strong evidence the underlying verification exists; this
test's purpose is to make that evidence explicit and durable, not to drive new production code. If it
passes immediately, that's the proof the directive asked for. If it fails, that is itself the "smallest
P2-compatible fail-closed check" needs to be added — in that case, add the minimal missing check
directly at the call site that skipped verification (do not touch `materializeStoredSkill`/
`verifyStoredSkill` themselves; they're already correct per the Store-level test), re-run, confirm PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/adapters/src/skill-update-integrity.test.ts
git commit -m "test(p5a): prove local apply fails closed on content-hash mismatch"
```

(If Step 2 required a production fix, `git add` that file too and adjust the commit message to
`fix(p5a): ...` instead of `test(p5a): ...`.)

---

### Task 10: Web integration — fixes the P5 Task 9 Critical finding

**Files:**
- Modify: `apps/web/app/skills/skills-data.ts` + `skills-data.test.ts`
- Modify: `apps/web/app/skills/skill-detail-data.ts` + `skill-detail-data.test.ts`
- Modify: `apps/web/app/skills/actions.ts`
- Modify: `apps/web/app/skills/[skillId]/page.tsx`
- Modify: `apps/web/app/skills/_components/skills-table.tsx`
- Modify: `apps/web/app/skills/_components/skill-actions.tsx`

**Interfaces:**
- Consumes: the new `SkillSummary`/`SkillDetail`/`SkillReviewArtifact` shapes (Task 1); the new
  `approveSkillVersionAction`/`setSkillPausedAction` contract (approve now takes `reviewArtifactId`,
  not `candidateContentHash`/`candidateRevision`).

- [ ] **Step 1: Update `deriveRow` in `skills-data.ts`**

Replace every reference to `skill.updateStatus`/`skill.candidateVersion` with
`skill.sourceCheckState`/`skill.candidateRevision`. The priority chain becomes:

```typescript
  if (skill.paused) { primaryStatus = 'paused'; dot = 'neutral'; statusText = 'Paused'; }
  else if (skill.sourceCheckState === 'update-available') { primaryStatus = 'update-available'; dot = 'attention'; statusText = 'Update available'; }
  else if (!viewingMachineCheckedIn) { /* existing 'Not reported here yet' branch, unchanged */ }
  else if (!install) { /* existing 'Not installed here' branch, unchanged */ }
  else if (!installedHere) { /* existing 'Different version here' branch, unchanged */ }
  else { primaryStatus = 'ready'; dot = 'ready'; statusText = 'Ready'; }
```

Add a new row field: `sourceCheckNote: string | undefined` — `'not-checked'` ⇒
`"Updates haven't been checked yet."`; `'cannot-check'` ⇒ `"Can't check for updates from this
source."`; `'check-failed'` ⇒ `"Check failed."`; `'no-update'`/`'update-available'` ⇒ `undefined` (no
note needed — the primary status already communicates it). Replace the old `cannotCheckNote: boolean`
field with this richer `sourceCheckNote`, and update the one existing test that asserted
`cannotCheckNote === true` to assert the new note text instead. Add new test cases: `'not-checked'`
produces the correct note and does NOT produce the `'Ready'` statusText when otherwise ready-eligible
(it should — not-checked doesn't block Ready; only the install-state checks do); `'check-failed'`
produces its own distinct note.

- [ ] **Step 2: Update `skills-table.tsx`**

Render `row.sourceCheckNote` next to the source label where `row.cannotCheckNote` used to render (same
position, generalized to the new field). Add it to the `checkedAt` display if the Final Contract
density allows (contract §19's "do not overcrowd list rows" guidance — keep `checkedAt` out of the list
row; it belongs on detail only, per the plan's Global Constraints already citing this).

- [ ] **Step 3: Update `loadSkillDetail` in `skill-detail-data.ts`**

Mirror Step 1's priority chain exactly (same three-way distinction already shared with `deriveRow`).
Replace the view's `updateAvailable`/`candidateVersion`/`cannotCheckNote`/`filesAvailable`/`files`/
`diffAvailable`/`diffFiles` fields with: `sourceCheckState`, `checkedAt`, `candidateRevision?`,
`reviewArtifactId?`, `sourceCheckNote?` (same values as Step 1), and `reviewArtifact:
SkillDetailReviewArtifactView | null` where:

```typescript
type SkillDetailReviewArtifactView = {
  reviewArtifactId: string;
  candidateRevision: string;
  files: {
    relativePath: string;
    kind: 'added' | 'modified' | 'removed';
    binary: boolean;
    beforeText?: string;
    afterText?: string;
    beforeSize?: number;
    afterSize?: number;
  }[];
};
```

mapped directly from `skill.reviewArtifact` (present only when `sourceCheckState ===
'update-available'`). Remove the old `filesAvailable`/`files`/`diffAvailable`/`diffFiles` fields
entirely — they described the old, always-null backend shape and are superseded.

Update every existing test in `skill-detail-data.test.ts` that referenced the removed fields; add new
tests: `update-available` with a real `reviewArtifact` renders its files; `update-available` where the
backend reports no artifact (bounds exceeded — `reviewArtifactId` absent even though
`sourceCheckState === 'update-available'`) renders an honest "exceeds V0 review limits, can't be
reviewed here, Approve isn't available for this update" state, distinct from "no update"/"not checked".

- [ ] **Step 4: Fix the Critical bug in `actions.ts`**

`approveSkillVersionAction`'s input becomes `{ skillId: string; reviewArtifactId: string }` — remove
`candidateContentHash`/`candidateRevision` entirely from its signature and from the call to
`getCloudService().approveSkillVersion`.

- [ ] **Step 5: Fix `skill-actions.tsx`**

The component's `approve()` handler now calls `approveSkillVersionAction({ skillId, reviewArtifactId })`
using the `reviewArtifactId` prop (passed down from the detail page) instead of constructing a bogus
`candidateContentHash`. The button is **disabled (not just non-functional) when `reviewArtifactId` is
absent** — i.e., when `sourceCheckState === 'update-available'` but bounds were exceeded and no
artifact exists — with a `title`/adjacent text explaining why ("This update exceeds STAK's V0 review
limits and can't be approved from the browser yet").

- [ ] **Step 6: Update `[skillId]/page.tsx`**

Replace the old diff-rendering block (`view.diffAvailable ? ... : "No candidate diff is available"`)
with one driven by `view.reviewArtifact`: when present, render each file's kind/path and, for
non-binary files, the actual before/after text (a simple two-column or unified before/after block is
sufficient — reuse the existing dark-panel styling conventions from `skills.css`); for binary files,
render "`<path>` changed (binary file)" with before/after size, never attempting a text preview.
Replace the old "Files" section (which always rendered the honest-unavailable state since `files` was
always null) — that section is now fully superseded by the review-artifact's file list when an update
is being reviewed, and stays absent (not a fake empty "Files" tab) when there's no pending update, per
the plan's Global Constraint deferring full approved-tree browsing. Pass `reviewArtifactId` down to
`SkillActions`.

- [ ] **Step 7: Run the web test suite + typecheck**

Run: `cd apps/web && npx tsc --noEmit && npx vitest run app/skills`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/skills
git commit -m "fix(p5a): web Skills UI uses persisted source-check state + approve-by-artifact"
```

---

### Task 11: Cross-cutting test sweep

**Files:** whichever test files from Tasks 6/8 don't yet exercise these specific cases — check first,
only add what's missing.

**Checklist against the brief's test matrix (§25):** confirm each of the following has a passing test
somewhere in the suite, and add the ones that don't:
- Duplicate artifact upload is idempotent (same artifact re-uploaded doesn't error or double-create).
- Path traversal in a Skill's materialized subtree is rejected (Task 5 covers the materialization
  side; confirm there's no second path where an untrusted relative path reaches the filesystem
  unchecked in `buildReviewArtifactFiles` or the upload/report service methods).
- Symlink entries in a materialized tree don't crash the diff/bounds logic (a `SkillTreeEntry` of
  `type: 'symlink'` reaching `buildReviewArtifactFiles` — confirm it's handled, even if trivially
  excluded from byte-counting, rather than throwing an unhandled type error).
- Cross-account artifact access is rejected (Task 6 Step 7 covers approval; add the equivalent check
  for `getSkillDetail` if not already implicit via `skillSummaries(userId)`'s existing per-user
  scoping).
- Privacy: no absolute/home-relative path ever appears in any `ReviewArtifactFile.relativePath` —
  `validateTreePath` already guarantees this at materialization time (Task 5); add one explicit test
  asserting `buildReviewArtifactFiles` rejects or sanitizes an already-malformed path if one somehow
  arrived (defense in depth, matching the existing `UnsafeTreePathError` pattern).

- [ ] **Step 1–N:** for each gap found, write the failing test, confirm it fails (if genuinely new
  behavior) or passes immediately (if already covered — note which), implement if needed, confirm
  pass, commit per gap or in one batched commit if all gaps are additive tests with no production
  change: `test(p5a): close cross-cutting coverage gaps (idempotency, path/symlink safety, cross-account)`.

---

### Task 12: Full validation pass

- [ ] **Step 1:** `cd "C:/Users/NT/Desktop/stack" && npx turbo run typecheck lint test 2>&1 | tail -100`
  (or run per-package if `turbo` isn't configured for a filtered run — check `turbo.json` first) across
  every touched package: `spec`, `shared` (untouched, but confirm), `core`, `store` (untouched,
  confirm), `cloud-server`, `cloud-client`, `cli`, `adapters`, `apps/web`.
- [ ] **Step 2:** `npx prettier --check` across every file touched in this plan.
- [ ] **Step 3:** `git diff --check` for whitespace errors.
- [ ] **Step 4:** Privacy grep sweep:
  `grep -rniE "[A-Za-z]:\\\\Users|/home/|/Users/" packages/core/src/skill-check.ts packages/cli/src/skill-check-runner.ts apps/web/app/skills` → expect clean.
  `grep -rniE "GIT_ASKPASS|credential|password|token" packages/core/src/skill-check.ts packages/cli/src/skill-check-runner.ts` → manually confirm every match is a safe identifier name, not a leaked value.
- [ ] **Step 5:** Confirm `supabase/migrations/0006_skill_review_checks.sql` was never applied — `git
  log`/`git status` show it as a committed file only; no `supabase db push`/equivalent was run this
  session.
- [ ] **Step 6:** Confirm no real-account mutation — grep this session's test files for the real
  account's identifiers (none should appear; all fixtures use synthetic `user-1`/`skill_test...`-style
  ids).

---

### Task 13: Phase report

No code changes. Compose the 20-point report the brief's §27 requires and present it to the user, then
**stop** — do not resume the remaining blocked P5 Task 9/10 UI wiring automatically, do not merge, do
not push, do not apply the migration.

---

## Self-Review

**Spec coverage:** §1 (responsibility model) ⇒ enforced structurally — no task touches Cloud-side Git
fetching; Tasks 5/8 are the only ones that spawn `git`, both in `packages/core`/`packages/cli`. §2
(trust model) ⇒ Task 1's schema comment + Task 6's `uploadSkillReviewArtifact` (verifies only
`artifactPayloadHash`, never recomputes `candidateContentHash`) + the architecture-spike addendum
already committed. §3 (three data conditions) ⇒ Task 1's `sourceCheckStateSchema`, Task 6's read-model
rewrite, Task 10's web rendering. §4 (base-bound) ⇒ Task 6's `current_` staleness check in
`skillSummaries()`. §5 (stale/superseded) ⇒ Task 6 Step 7/8's three explicit test cases (A/B/C) plus
the "upstream moved without recheck" case. §6 (latest-only) ⇒ Task 3's "replace" test, Task 6's upload
method's metadata-before-blob-removal ordering. §7/§8 (payload sufficiency, binary) ⇒ Task 5's
`buildReviewArtifactFiles`. §9 (full-tree browsing deferred) ⇒ Task 10 Step 6 explicitly removes the
old always-unavailable "Files" tab rather than building a new always-empty one. §10 (CLI command) ⇒
Task 8. §11 (private Git privacy) ⇒ structural — Task 5/8 run with the user's own local Git auth,
never touch Cloud. §12 (failure vs. cannot-check) ⇒ Task 1's `check-failed` state + Task 8's sanitized
failure reason. §13 (data model) ⇒ Tasks 2/3/4. §14 (approval by artifact id) ⇒ Task 6 Step 8, Task 10
Step 4/5. §15 (artifactPayloadHash separate from candidateContentHash) ⇒ Task 1's schema, Task 6's
upload verification. §16 (bounds) ⇒ Task 5's three bound checks + Task 8's "exceeds bounds → no
artifact" path. §17 (public-stack) ⇒ not separately implemented as its own task — flagged as a known
scope reduction: this plan's Task 5/8 implement the **Git** materialization path fully; a public-stack
candidate materialization path (reusing `resolvePublicStackSourceLatest` + whatever existing
public-stack content-fetch mechanism the registry already has) is deliberately left for a fast-follow
rather than bundled here, since the original audit never located a ready-made "fetch exact published
version's file content" primitive to reuse — inventing one would be new infrastructure the user asked
this plan to scope tightly around Git first. **This is called out explicitly in the Task 13 report as a
known gap, not silently dropped.** §18 (local/pinned) ⇒ unchanged P2 semantics, exercised by Task 8's
`cannot-check`/`pinned` test. §19 (P5 read model) ⇒ Task 6. §20 (approval write change) ⇒ Task 6/Task
10. §21 (apply verification) ⇒ Task 9. §22 (migration not applied) ⇒ Task 2 Step 2's explicit
non-application, Task 12 Step 5's confirmation. §23 (docs first) ⇒ already done and committed
(`c61cfb7`) before this plan was written. §24 (implementation order) ⇒ Tasks 1→10 follow A→L exactly,
with the public-stack sub-item of F/G knowingly deferred per §17's note above. §25 (test matrix) ⇒
distributed across Tasks 1/3/5/6/8/9, swept for gaps in Task 11. §26 (real account safety) ⇒ every
task's tests use synthetic fixtures; Task 12 Step 6 double-checks.

**Placeholder scan:** Task 7 and parts of Task 8/11 are intentionally less fully pre-written than the
others (cloud-client's exact existing shape and the "exceeds bounds" wire decision were not fully
resolved during planning, since they depend on reading files this planning pass didn't have budget to
read in full, or require a judgment call about extending an already-written schema) — each such spot
says exactly what to read first and what decision to make, rather than leaving a bare "TODO" or
"handle appropriately." This is the plan's one accepted deviation from "no placeholders," scoped to
two tasks, each with explicit resolution criteria.

**Type consistency:** `ReviewArtifactFileRecord` (Task 3/5), `SkillReviewArtifact`/
`ReviewArtifactFile` (Task 1), and the web's `SkillDetailReviewArtifactView` (Task 10) are three
related-but-distinct shapes at three different layers (repository record, wire/spec type, view-model) —
intentionally not the same type, matching this codebase's existing pattern of a `*Record` repository
shape, a Zod spec shape, and a page-specific view shape for every other product read model already
built in P3/P4/P5. Field names are kept consistent in meaning across all three (`relativePath`, `kind`,
`binary`, `before`/`after`) to make the mapping between them mechanical.
