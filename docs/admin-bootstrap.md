# STAK Admin — Owner Bootstrap

One-time production setup to grant the first `owner` admin account. Do not
run this automatically — a human runs it after confirming the signed-in
GitHub account to grant.

1. Apply pending migrations to production (manual step, same convention as
   every prior migration):
   - `supabase/migrations/0013_admin_users.sql`
   - Via Supabase Dashboard → SQL Editor (paste and run), or
     `supabase db push` from the repo root if the CLI is linked to the
     production project.

2. Find your Supabase Auth user UUID:
   - Supabase Dashboard → Authentication → Users → locate your account by
     email/GitHub username → copy the `UID` column value.

3. Insert yourself as owner (SQL Editor):

   ```sql
   insert into public.admin_users (user_id, role)
   values ('<your-uuid-here>', 'owner');
   ```

4. Sign in to the web app with that account and visit `/admin` — it should
   render the Overview placeholder instead of 404.
