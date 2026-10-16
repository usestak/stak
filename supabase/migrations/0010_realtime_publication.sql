-- 0010_realtime_publication.sql — enables Supabase Realtime (postgres_changes) for the
-- sync-invalidation signals added in apps/web/lib/sync/realtime-sync.ts and
-- apps/web/lib/sync/public-stak-sync.ts.
--
-- NOT APPLIED TO PRODUCTION. Reviewable proposal only — see
-- docs/architecture/realtime-sync-plan.md for the full audit this migration implements.
--
-- No RLS changes: every table below already has a sufficient SELECT policy from its
-- original migration (0001, 0002, 0004, 0008, 0009) — owner-only `auth.uid() = user_id`
-- for the first five, public-read `using (true)` for the last two. Realtime's
-- postgres_changes honors the subscriber's RLS at delivery time, so these existing
-- policies were simply never previously exercised by a live anon-key client.
--
-- No REPLICA IDENTITY change: the client-side handler for every table below ignores the
-- row payload entirely and only uses the table name to decide which domain to invalidate
-- (see the modules above) — REPLICA IDENTITY DEFAULT's primary-key-only payload on change
-- events is sufficient; FULL would only matter if a client needed pre-change row values,
-- which none of these handlers do.
--
-- Deliberately excluded: public.memory_backups (contains wrapped_dek wrapped-DEK key
-- material; a postgres_changes event ships the entire row with no column projection — see
-- realtime-sync-plan.md §3).

alter publication supabase_realtime add table
  public.user_stacks,
  public.user_stack_versions,
  public.machines,
  public.machine_skill_versions,
  public.machine_project_presence,
  public.public_stacks,
  public.public_stack_versions;

-- Rollback (not applied; keep for reference — see the plan's final report for exact
-- production rollout/rollback steps):
--
-- alter publication supabase_realtime drop table
--   public.user_stacks,
--   public.user_stack_versions,
--   public.machines,
--   public.machine_skill_versions,
--   public.machine_project_presence,
--   public.public_stacks,
--   public.public_stack_versions;
--
-- Dropping a table from the publication is immediate and has no data-loss risk: it only
-- stops future change events from being replicated to subscribers. It does not touch table
-- data, RLS policies, or existing columns. The app-side Realtime channels would simply stop
-- receiving events and fall back to BroadcastChannel + focus refresh only, with no code
-- change required to "fail safe".
