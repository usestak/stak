# External-Change Sync: Supabase Realtime Plan (not applied)

This document specifies — but does **not** apply — the production change needed to close the
last gap in the freshness contract: a CLI push, a backup, or a check-in from another machine
showing up in an already-open browser tab within ~1–2 seconds. The small, already-shipped
client-side layer (`apps/web/lib/sync/`) closes the same-browser cross-tab gap and softens this
one with a focus/visibility refresh; it cannot fully close it, because nothing today pushes a
signal from Supabase to an open tab.

No code in this repo enables any of this. Treat it as a reviewable proposal.

## 1. Why Realtime is viable here

CLI writes and web writes land in the exact same Postgres tables through the same
`CloudService`/repository layer (`packages/cloud-server/src/repository.ts`) — there is no
separate CLI-only datastore. A Realtime subscription on those tables would fire identically
regardless of which path produced the write.

## 2. Current authentication posture (verified, not assumed)

- The browser already holds an authenticated Supabase session: `apps/web/lib/supabase-server.ts`
  uses `@supabase/ssr`'s `createServerClient`, which sets `sb-*` auth cookies in the browser on
  login. Those cookies carry a real user JWT today — they're just never read by a browser-side
  Supabase client, because 100% of data reads currently go through the **service-role** key on
  the server (`apps/web/lib/supabase.ts`), which bypasses RLS entirely.
- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are already defined and public
  (`apps/web/.env.local`, `apps/web/lib/env.ts:44-45`). A browser Supabase client
  (`createBrowserClient` from `@supabase/ssr`) would reuse the existing anon key and the
  existing session cookie — **no new secret, no new auth flow.**
- Net: adding Realtime means the browser's _first-ever_ direct Supabase connection, but not a
  new credential or a new login step. The thing that changes is that RLS — previously only a
  backstop for a path that's never exercised — becomes the live authorization boundary for
  whatever the browser subscribes to. That's the part that deserves review before shipping, not
  the auth mechanism itself.

## 3. Minimum table set

| Table                      | Domain                                                       | Events               | Isolation              | Current RLS                                    | Sensitive columns?                                          | Use payload or signal-only? |
| -------------------------- | ------------------------------------------------------------ | -------------------- | ---------------------- | ---------------------------------------------- | ----------------------------------------------------------- | --------------------------- |
| `user_stacks`              | staks, sidebar, overview                                     | UPDATE               | `auth.uid() = user_id` | `user_stacks_owner_select` (0008)              | No                                                          | Signal-only                 |
| `user_stack_versions`      | staks, publication                                           | INSERT               | `auth.uid() = user_id` | `user_stack_versions_owner_select` (0008)      | No                                                          | Signal-only                 |
| `machines`                 | machines, sidebar, overview, memory (via `memory_backed_up`) | UPDATE               | `auth.uid() = user_id` | `machines_owner_select` (0001)                 | No (no fingerprints/paths; confirmed by 0004's own comment) | Signal-only                 |
| `machine_skill_versions`   | machines, skills                                             | INSERT/UPDATE/DELETE | `auth.uid() = user_id` | `machine_skill_versions_owner_select` (0004)   | No                                                          | Signal-only                 |
| `machine_project_presence` | machines, projects                                           | INSERT/UPDATE/DELETE | `auth.uid() = user_id` | `machine_project_presence_owner_select` (0004) | No                                                          | Signal-only                 |

**Deliberately excluded:**

- **`memory_backups`** — contains `wrapped_dek` (wrapped data-encryption-key material) and
  `payload_locator`/`payload_sha256`. None of this is sent to the browser today (verified:
  `wrapped_dek` only appears server-side in `apps/web/lib/memory-backend.ts`). A `postgres_changes`
  event ships the **entire row**, with no column projection — subscribing here would be a new
  exposure of key material to the client that nothing in the product currently needs. The
  `memory` domain's freshness need (the sidebar's "Backed up" indicator, `Overview`'s headline
  dot) is already fully served by `machines.memory_backed_up` / `machines.last_checkin_at`
  above, so there is no reason to add this table to the subscription set.
- **`public_stacks` / `public_stack_versions`** — publish/republish/unpublish write here (see
  `0002_public_stacks.sql:106-129`, `0009_public_share_lifecycle.sql:39-66`), and the detail page
  does need to know when they change. But their RLS is **public-read by design** (anyone can
  read a published STAK), not owner-scoped — so a Realtime subscription here would need a
  client-supplied filter (e.g. `owner_user_id=eq.<uid>`) for _efficiency_, not _authorization_;
  without it, every connected browser would receive every user's publish/unpublish events. This
  is not a privacy leak (the data is intentionally public), but it is unnecessary noise and a
  slightly different trust model from the other four tables, so it's called out as a **separate
  decision** rather than bundled into the "minimum set" above. If approved, subscribe with the
  owner filter.

## 4. Payload handling

Per the hybrid architecture already in place (`apps/web/lib/sync/`): **Realtime is an
invalidation signal, never reconstructed state.** The client-side handler for every table above
ignores the row payload and does exactly what `useStakSync`'s existing `onBroadcastMessage` path
does — triggers a debounced, coalesced `router.refresh()` so the server (still the
`CloudService`/repository layer, same as today) re-resolves the authoritative view. This also
means the `memory_backups` exclusion above is about not letting sensitive columns transit the
wire at all, not about an authorization gap — the design never reads subscribed payloads client-side
regardless of table.

## 5. REPLICA IDENTITY

Supabase's default `REPLICA IDENTITY DEFAULT` sends the primary key on every change event,
which is sufficient here since the client never reads row content — only "something in this
table changed, go refresh." No table above needs `REPLICA IDENTITY FULL`. (`FULL` would only
matter if the client needed pre-change values, e.g. to diff old vs. new row — it does not.)

## 6. Does a service-role write still emit a Realtime event?

Yes. Realtime's `postgres_changes` listens to the Postgres logical replication stream itself
(via `wal2json`/the `supabase_realtime` publication), which fires for every committed row
change regardless of which Postgres role made the write. Service-role writes from
`packages/cloud-server/src/repository.ts` (used by both CLI and web mutations) are ordinary
committed transactions and are therefore not distinguishable from "web-made" writes once in the
replication stream — RLS is then evaluated per-subscriber at delivery time, not per-writer.

## 7. Exact production change

### 7.1 Publication (repo-managed migration — the recommended path)

```sql
-- 0010_realtime_publication.sql
alter publication supabase_realtime add table
  public.user_stacks,
  public.user_stack_versions,
  public.machines,
  public.machine_skill_versions,
  public.machine_project_presence;
```

This is ordinary DDL and can ship as a normal numbered migration like the other nine — no
dashboard-only step is required for the publication itself. `public_stacks` /
`public_stack_versions` are intentionally omitted pending the separate decision in §3.

### 7.2 RLS changes

**None required.** Every table in the minimum set already has an owner-only `auth.uid() =
user_id` `select` policy from its original migration (0001, 0004, 0008). Realtime's
`postgres_changes` honors the subscriber's RLS at delivery time, so these existing policies are
sufficient as-is — they were just never previously exercised by a live anon-key client.

### 7.3 REPLICA IDENTITY changes

None required (see §5) — default is sufficient since payload content is never read.

### 7.4 Environment/app changes

- New file: `apps/web/lib/supabase-browser.ts` — a thin `createBrowserClient` wrapper reusing
  the existing public env vars. No new env vars.
- Extend `apps/web/lib/sync/use-stak-sync.ts`'s effect to also open Realtime channels (one per
  table, or one channel with multiple `postgres_changes` subscriptions) alongside the existing
  `BroadcastChannel` + focus listeners, routing through the same `createSyncController` so
  bursts across _all_ three signal sources (Realtime, BroadcastChannel, focus) coalesce into one
  `router.refresh()`.

### 7.5 Rollback procedure

```sql
-- rollback for 0010_realtime_publication.sql
alter publication supabase_realtime drop table
  public.user_stacks,
  public.user_stack_versions,
  public.machines,
  public.machine_skill_versions,
  public.machine_project_presence;
```

Dropping a table from the publication is immediate and has no data-loss risk — it only stops
future change events from being replicated to subscribers; it does not touch table data, RLS
policies, or existing columns. The app-side `useStakSync` Realtime channels would simply stop
receiving events and fall back to BroadcastChannel + focus refresh only, with no code change
required to "fail safe" (see §9).

## 8. Expected latency once enabled

```
CLI write / web write
  → Postgres commit                              ~instant
  → WAL → Realtime replication                   typically <500ms, Supabase-side
  → browser receives postgres_changes event       one WebSocket hop
  → createSyncController coalesce window           150ms (existing constant)
  → router.refresh()                               one RSC round-trip, same cost as any
                                                     existing router.refresh() today
```

Realistic end-to-end: usually under 1–2 seconds while the tab is active and the WebSocket is
connected. This is **not** a hard SLA — latency can grow under Supabase-side replication lag,
cold WebSocket reconnects after a dropped connection, or a browser tab that's been suspended by
the OS. The existing focus/visibility fallback (already shipped) covers exactly that failure
mode: if a tab reconnects or resumes focus after missing events, it refreshes anyway.

## 9. Fallback / reconnect behavior

Per the hybrid principle, Realtime is additive, never a hard dependency:

- On subscribe failure or disconnect, `useStakSync` would catch the error the same way it
  already does for `BroadcastChannel` construction failures (try/catch, channel stays `null`,
  no thrown error, no user-visible error state).
- The existing focus/visibility refresh is the reconnect fallback — it already fires
  independently of Realtime and doesn't know whether Realtime is enabled.
- No permanent polling is added. If a lighter polling fallback were ever justified (e.g.
  Supabase Realtime has a known outage pattern worth hedging), it should be visibility-aware
  (`document.visibilityState === 'visible'` only) and on the order of 60s+, not 1-2s — a safety
  net for a rare failure mode, not a primary mechanism.

## 10. Performance vs. naive polling (illustrative, 100 simultaneously active users)

| Approach                                                | Requests/queries per minute (100 users)                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Naive global 1s `router.refresh()` polling, 1 page each | 100 users × 60 refreshes/min = **6,000 RSC renders/min**, each re-running every `CloudService` call the current route makes (often 3-5 Supabase queries) → **18,000-30,000 Supabase queries/min** even when nothing changed                                                                                                                                                                                    |
| BroadcastChannel (shipped) + Realtime + focus fallback  | Near-zero steady-state cost: Realtime is one persistent WebSocket per active tab (no polling queries), BroadcastChannel is free (no network), and `router.refresh()` only fires on an actual mutation or an actual external change — for 100 users making a normal rate of mutations (a handful per minute across the whole user base), this is on the order of **tens of refreshes/min total**, not thousands |

Order-of-magnitude reduction: roughly **100-300x fewer Supabase queries** than naive 1s global
polling for this illustrative load, because refreshes become event-driven instead of
clock-driven.

## 11. Recommendation on approving Realtime for 0.1

**Hold it past 0.1.** The shipped BroadcastChannel + focus-refresh layer already satisfies
requirements A and B of the freshness contract (same-page mutation: immediate; same-browser tab:
near-instant) and meaningfully softens C (external/CLI: bounded by how often the user's tab
regains focus, which in practice is frequent for an active user, just not a guaranteed ≤2s
bound). The remaining gap — a tab left open and unfocused missing a CLI push for longer than a
focus cycle — is a real but narrow edge case, not a launch blocker.

Everything in §§1-9 above is ready to implement in a follow-up once:

1. the `public_stacks`/`public_stack_versions` filtering decision in §3 is made, and
2. someone with Supabase project access confirms `supabase_realtime` can be extended via a
   normal repo-managed migration in this project's hosting setup (the audit found no
   `supabase/config.toml` checked in, so this should be confirmed against the actual
   hosted/self-hosted project rather than assumed).

No RLS weakening, no schema change, and no new secret is required for either the publication
extension or the browser client.
