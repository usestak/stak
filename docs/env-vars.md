# Environment variable inventory

No real values appear here. Actual values are configured per deployment.

**`STAK_*` is the preferred namespace from 0.1.0.** Each variable below also accepts a
legacy **`STACK_*`** alias through the pre-1.0 compatibility period. For any pair, set
_one_ of them; if both are set to different values STAK fails with a clear configuration
error (it never silently prefers one, merges, or copies). Prefer `STAK_*` for all new
configuration.

## Local state home

| Name         | Purpose                              | Default   |
| ------------ | ------------------------------------ | --------- |
| `STAK_HOME`  | Root of STAK's canonical local state | see below |
| `STACK_HOME` | Legacy alias for `STAK_HOME`         | —         |

- **New installs** default to `~/.stak`.
- An existing **legacy `~/.stack`** is **adopted in place** when it holds recognizable
  state and `~/.stak` does not — nothing is moved, copied, renamed, or deleted.
- If **both** `~/.stak` and `~/.stack` hold recognizable state, STAK refuses to guess:
  set `STAK_HOME` explicitly to the directory you intend to use.
- An empty or unrelated directory is not treated as state, so an accidentally-created
  empty `~/.stak` never hides an existing `~/.stack`.

## CLI (local)

| Name           | Purpose                                                                      | Required            | Secret | Default                                             |
| -------------- | ---------------------------------------------------------------------------- | ------------------- | ------ | --------------------------------------------------- |
| `STAK_API_URL` | STAK Cloud API base URL (legacy alias `STACK_API_URL`)                       | Cloud commands only | No     | localhost in dev; unset fails clearly in production |
| `STAK_ENV`     | Set to `production` to disable the localhost dev fallback for `STAK_API_URL` | No                  | No     | unset (dev)                                         |
| `NODE_ENV`     | Also treated as production for the dev fallback rule                         | No                  | No     | unset                                               |

Local commands (`scan`, `init`, `status`, `diff`, `use <local>`, `remove`, `run`,
`try <local>`) need none of these. The CLI token lives in `$STAK_HOME/auth.json`, not an
environment variable.

## Web app — public (browser-exposed)

| Name                            | Purpose                    | Required | Secret |
| ------------------------------- | -------------------------- | -------- | ------ |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL       | Yes      | No     |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon (public) key | Yes      | No     |

## Web app — server only

| Name                        | Purpose                                                               | Required | Secret  | Default               |
| --------------------------- | --------------------------------------------------------------------- | -------- | ------- | --------------------- |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side privileged DB/storage access                              | Yes      | **Yes** | —                     |
| `STAK_TICKET_SECRET`        | Signs snapshot upload/download tickets (alias `STACK_TICKET_SECRET`)  | Yes      | **Yes** | —                     |
| `STAK_APP_URL`              | Public app URL for CLI/public links (alias `STACK_APP_URL`)           | Yes      | No      | —                     |
| `STAK_SNAPSHOT_BUCKET`      | Private Storage bucket name (alias `STACK_SNAPSHOT_BUCKET`)           | No       | No      | `stack-snapshots`     |
| `STAK_MAX_SNAPSHOT_BYTES`   | Max accepted snapshot archive size (alias `STACK_MAX_SNAPSHOT_BYTES`) | No       | No      | `209715200` (200 MiB) |

The `NEXT_PUBLIC_SUPABASE_*` and `SUPABASE_SERVICE_ROLE_KEY` names are third-party
(Supabase) and unchanged. The storage bucket default (`stack-snapshots`) is unchanged for
compatibility with existing storage. The service role key and ticket secret must never
reach the browser, the CLI, logs, or API responses; the server reads required variables
via a fail-fast helper, so a missing secret produces a clear startup error rather than an
insecure default.

## Test-only

None. The automated suite requires no environment configuration, no live Supabase, and no
network.
