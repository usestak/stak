-- Product analytics event log (STAK Admin design spec, Phase 3 consumer).
-- Added now (Phase 2) rather than deferred to Phase 3 so migration numbering
-- stays contiguous -- Phase 3's instrumentation work will write to this
-- table, but creating it is schema-only and has no behavioral effect until
-- something calls recordEvent() against it.
--
-- RLS enabled with NO policies: writes happen only via the recordEvent
-- callback injected into createCloudService() (apps/web/lib/cloud-service.ts),
-- which inserts via the service-role client; reads happen only via admin
-- pages using the same client. Mirrors the posture of public.feedback
-- (0012) and public.admin_users (0013).
create table if not exists public.product_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  event_name text not null,
  machine_id text,
  success boolean,
  error_code text,
  cli_version text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

alter table public.product_events enable row level security;
-- No policies: service-role client only.

create index if not exists product_events_name_created_idx
  on public.product_events (event_name, created_at desc);
create index if not exists product_events_user_created_idx
  on public.product_events (user_id, created_at desc);
