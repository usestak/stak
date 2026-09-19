# Stack Cloud setup (Phase 8)

Stack Cloud is the optional transport that backs `stack push` / `stack pull`.
Local commands (`scan`, `init`, `status`, `diff`, `use`, `remove`, `run`, `try`)
never require it.

The automated test suite does **not** need a live Supabase project — the cloud
service is exercised through an in-memory implementation. These steps are only
needed to run the real hosted app in `apps/web`.

## 1. Create a Supabase project

Create a project at supabase.com. From **Project Settings → API**, note the
project URL, the `anon` key, and the `service_role` key.

## 2. Apply the database migration

Apply `supabase/migrations/0001_stack_cloud.sql` (via the Supabase SQL editor or
`supabase db push`). It creates the tables, indexes, the append-only version
guard, the atomic `commit_environment_version` function, Row Level Security
policies, and the private `stack-snapshots` Storage bucket.

## 3. Configure the GitHub OAuth provider

In **Authentication → Providers → GitHub**, enable GitHub and supply a GitHub
OAuth app's client id/secret. Set the GitHub OAuth app callback URL to your
Supabase auth callback (`https://<project>.supabase.co/auth/v1/callback`).

In **Authentication → URL Configuration**, add your web app's callback:
`http://localhost:3000/auth/callback` for development (and your production URL).

## 4. Configure `apps/web`

Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in the Supabase
URL, anon key, and service role key, plus a strong `STACK_TICKET_SECRET`. The
service role key is server-only — it is never exposed to the browser, the CLI,
API responses, or logs.

Run the web app:

```bash
pnpm --filter @stack/web dev
```

## 5. Point the CLI at the API

Set `STACK_API_URL` to the web app's origin (development defaults to
`http://localhost:3000` when unset). Production builds fail clearly if a cloud
command is run without a configured endpoint.

```bash
export STACK_API_URL=http://localhost:3000
stack login
stack push
```

## Notes and future hardening

- The CLI token is stored at `$STACK_HOME/auth.json` with owner-only permissions
  where supported. Windows at-rest credential protection (DPAPI / OS keychain)
  is a deferred hardening item; the credential-storage abstraction lets it be
  swapped without changing CLI behavior.
- Snapshot upload/download stream through the API with short-lived signed
  tickets; the Storage bucket is private and has no public read policy.
