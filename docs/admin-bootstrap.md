# STAK Admin — Owner Bootstrap

One-time production setup to grant the first `owner` admin account. Do not
run this automatically — a human runs it after confirming the signed-in
GitHub account to grant.

1. Apply pending migrations to production, **in this exact order** (manual
   step, same convention as every prior migration):
   - `supabase/migrations/0013_admin_users.sql`
   - `supabase/migrations/0014_feedback_workflow.sql`
   - `supabase/migrations/0015_product_events.sql`
   - `supabase/migrations/0017_admin_indexes.sql` (there is no `0016` — it
     was renumbered during development; this is expected, not a gap)
   - Via Supabase Dashboard → SQL Editor (paste and run each in order), or
     `supabase db push` from the repo root if the CLI is linked to the
     production project. If this project's migration history already has
     a (different) `0016` applied from before this renumbering, `db push`
     will refuse the out-of-order `0017` — run `supabase migration repair`
     for that version first.

   **Apply all four before deploying the admin dashboard code**, not just
   `0013`. Without `0014`, Overview's feedback tiles and the entire
   Feedback section throw (`feedback.status` doesn't exist yet). Without
   `0015`, Usage/Reliability/System throw, and every live push/pull logs a
   harmless-but-noisy `[product_events] insert failed` server-side (the
   insert runs in `after()` and only logs — it never affects the push/pull
   response itself).

2. Find your Supabase Auth user UUID:
   - Supabase Dashboard → Authentication → Users → locate your account by
     email/GitHub username → copy the `UID` column value.

3. Insert yourself as owner (SQL Editor):

   ```sql
   insert into public.admin_users (user_id, role)
   values ('<your-uuid-here>', 'owner');
   ```

4. Sign in to the web app with that account and visit `/admin` — it should
   render the real Overview page (metrics, date-range pills) instead of 404.

See `docs/admin-metric-definitions.md` for what each number on the
dashboard actually means, including which metrics are intentionally
unavailable or deferred.
