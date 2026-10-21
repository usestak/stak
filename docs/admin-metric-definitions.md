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

**Caveat**: `cloud.pull.succeeded`/`cloud.pull.failed` events are emitted
by the same server-side `getEnvironment` call used by `stak push` and
`stak status` as an internal precondition check, not only by `stak pull`.
The server has no signal to distinguish these without a CLI change, so
this is really an "environment read" rate, not a pure pull rate — Usage's
page copy reflects this; Reliability's doesn't yet (follow-up candidate).
`cloud.pull.failed` specifically excludes the benign
`remote-environment-not-found` case (a first-time user's push/status
against a never-created environment), so it isn't inflated by that.

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
default. Several admin loaders (Usage's per-day buckets, Reliability's
failure grouping, the Feedback and Users lists) fetch row-level data for
aggregation that can't be expressed as a single database count, and will
silently truncate once the underlying table/range exceeds that cap, with
no on-page indication. Accepted as a known limitation pending a proper
server-side aggregate (RPC/view) — see the Phase 2/3/4 ledger entries in
`.superpowers/sdd/progress.md` for the specific instances and reasoning.
