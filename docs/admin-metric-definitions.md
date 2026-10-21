# STAK Admin — Metric Definitions

Permanent reference so these numbers don't drift as the dashboard evolves.
If a definition changes, update this file in the same commit.

## Activated user
A user with at least one row in `environment_versions` (i.e. has made a
successful authenticated Cloud push), ever — not scoped to the selected
date range. Computed in `apps/web/app/admin/overview-data.ts`.

## Activation rate
Activated users ÷ total signed-up users, both all-time counts (not
range-scoped — see "Activated user"). Returns `null`, not `NaN`, when
there are zero signed-up users.

## Portable user
A user with active (non-revoked) machines spanning >= 2 distinct
`machine_id`s. Computed once, shared across Overview/Activation/Usage via
`apps/web/lib/admin-metrics.ts`'s `loadActiveMachinesByUser`/
`countPortableUsers` — every page that shows this number goes through the
same implementation so the figure can't drift between pages.

## Push / pull success rate
Successful `product_events` of that type ÷ (successful + failed) of that
type, in the selected date range. Returns `null` when there are zero
attempts of that type in range. Computed via server-side `head:true`
counts in `apps/web/app/admin/reliability/reliability-data.ts`.

**Caveat (pull)**: `cloud.pull.succeeded`/`cloud.pull.failed` events are
emitted by the same server-side `getEnvironment` call used by `stak push`
and `stak status` as an internal precondition check, not only by `stak
pull`. The server has no signal to distinguish these without a CLI
change, so this is really an "environment read" rate, not a pure pull
rate — Usage's page copy reflects this; Reliability's doesn't yet
(follow-up candidate). `cloud.pull.failed` specifically excludes the
benign `remote-environment-not-found` case (a first-time user's
push/status against a never-created environment), so it isn't inflated
by that.

**Caveat (push)**: `cloud.push.failed` has no equivalent exclusion. It
records every error code the push path can produce, including expected,
non-reliability-signal outcomes a normal workflow produces regularly —
e.g. `remote-conflict` (the user needs to pull before pushing again) and
`bundle-invalid` (a malformed local bundle, a client-side issue, not a
server reliability problem). The push failure rate therefore includes
some volume of "working as intended" conflicts alongside genuine
failures. Not yet split out — a follow-up candidate, same as the pull
caveat above.

## Open feedback
`feedback.status` in `('new', 'reviewing')`.

## Weekly active user (WAU)
**Not implemented as of Phase 5.** Deferred — see Phase 1 final-review
carry-over notes; no page currently renders a WAU figure.

## CLI version breakdown
**Unavailable.** The CLI sends no version header on any Cloud API
request. Not faked — every page that would show this explicitly renders
"Unavailable — no CLI version header exists yet" rather than a number.
(Distinct from "Published CLI version" on the System page, which is just
`packages/cli/package.json`'s version string — a single known value, not
a breakdown of what versions real users are actually running.)

## Memory recoveries
**Not instrumented.** No code path emits a `memory.recovered` event yet.
Usage's tile renders the literal string "Not instrumented yet" rather than
a real-looking `0`.

## Row-cap caveat (applies to several loaders)
Hosted Supabase/PostgREST caps any single response at 1000 rows by
default, with no server-side override configured in this repo. Every
loader below fetches row-level data for an aggregation that can't be
expressed as a single database `count`, and will silently truncate (no
on-page indication) once the underlying table/range exceeds 1000 rows,
with no `.order()` on several of them — meaning the rows dropped are
arbitrary, not "the most recent N":

- `apps/web/app/admin/overview-data.ts` — fetches every `environment_versions.user_id`
  row (unordered) to compute distinct `activatedUserIds`. Undercounts
  Activated users / Activation rate once total pushes exceed 1000 —
  notably, this can happen well before the user count does.
- `apps/web/app/admin/activation/activation-data.ts` — same pattern for
  `environment_versions.user_id` (First push) and `cli_tokens.user_id`
  (CLI-authenticated).
- `apps/web/lib/admin-metrics.ts`'s `loadActiveMachinesByUser` — fetches
  every `machines` row (unordered). Undercounts Portable users and
  Active machines once total machine rows exceed 1000. Shared by
  Overview, Activation, and Usage, so the undercount is consistent across
  pages at least (all three see the same truncated set).
- `apps/web/app/admin/users/users-data.ts` — profiles are paginated
  (`.order()` + `.limit(500)`), but its `environment_versions`/`feedback`
  row fetches (for push/feedback counts) use `.limit(MAX_ROWS * 20)` =
  10,000 with no `.order()` — the comment there describes this as a
  stopgap cap, but the *real* ceiling is 1000 regardless of what's
  requested, so counts for very active users can silently undercount.
- `apps/web/app/admin/usage/usage-data.ts`'s per-day buckets and
  `apps/web/app/admin/reliability/reliability-data.ts`'s failure grouping
  — these at least `.order('created_at', { ascending: false })` with an
  explicit `.limit(1000)`, so truncation drops the *oldest* rows in range
  rather than an arbitrary set, but still truncates silently.
- The Feedback list (`feedback-data.ts`) and the above Users list both
  cap at 500 rows client-side in addition to the 1000-row server cap.

Accepted as a known limitation pending a proper server-side aggregate
(RPC/view) that can compute these as real database-side `count(distinct
...)` or `GROUP BY` queries instead of fetching rows into Node — see the
Phase 2/3/4/5 ledger entries in `.superpowers/sdd/progress.md` for the
reasoning behind accepting each instance rather than blocking on a
rewrite.

## Deferred from v1 (not silently missing — listed here on purpose)
The design spec described a larger surface than v1 ships. These are
known gaps, not oversights:

- **Activation funnel's "First pull" stage.** The spec's funnel is
  Accounts → CLI-authenticated → First push → First pull → Portable.
  Phase 2 shipped the funnel without this stage (pull had no data source
  yet at the time); Phase 3 added `cloud.pull.succeeded`/`.failed`
  events, but nobody revisited Activation to add the stage. The data to
  add it now exists.
- **Public STAK try/use/conversion.** `public_stak.tried`/`.used` events
  were never instrumented; Usage has no tiles for them.
- **Memory recovery success rate on Reliability.**
  `memory.restore_conflict` was never emitted; only Usage's "Memory
  recoveries" tile acknowledges this gap (as "Not instrumented yet").
- **Users list columns.** The spec listed last activity, activation
  state, first-push date, pull count, and a Memory-usage indicator. The
  shipped list shows name, joined date, push count, machine count, and
  feedback count only.
- **Admin nav entry in the signed-in app's `AppSidebar`.** Carried over
  from Phase 1's final review and never closed — admins currently reach
  `/admin` only by typing the URL, not via a link in the main app shell.
- **`loading.tsx` files.** The spec asked for explicit loading states;
  none were added (each admin page's own render is the only loading
  signal, via Next's default suspense boundary behavior).
