# Environment variable inventory

No real values appear here. Actual values are configured per deployment.

## CLI (local)

| Name            | Purpose                                                                       | Required            | Secret | Default                                             |
| --------------- | ----------------------------------------------------------------------------- | ------------------- | ------ | --------------------------------------------------- |
| `STACK_HOME`    | Root of Stack's canonical local state                                         | No                  | No     | `~/.stack`                                          |
| `STACK_API_URL` | Stack Cloud API base URL                                                      | Cloud commands only | No     | localhost in dev; unset fails clearly in production |
| `STACK_ENV`     | Set to `production` to disable the localhost dev fallback for `STACK_API_URL` | No                  | No     | unset (dev)                                         |
| `NODE_ENV`      | Also treated as production for the dev fallback rule                          | No                  | No     | unset                                               |

Local commands (`scan`, `init`, `status`, `diff`, `use <local>`, `remove`, `run`,
`try <local>`) need none of these. The CLI token lives in
`$STACK_HOME/auth.json`, not an environment variable.

## Web app — public (browser-exposed)

| Name                            | Purpose                    | Required | Secret |
| ------------------------------- | -------------------------- | -------- | ------ |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL       | Yes      | No     |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon (public) key | Yes      | No     |

## Web app — server only

| Name                        | Purpose                                                    | Required | Secret  |
| --------------------------- | ---------------------------------------------------------- | -------- | ------- |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side privileged DB/storage access                   | Yes      | **Yes** |
| `STACK_TICKET_SECRET`       | Signs short-lived snapshot upload/download tickets         | Yes      | **Yes** |
| `STACK_APP_URL`             | Public app URL used to build CLI verification/public links | Yes      | No      |
| `STACK_SNAPSHOT_BUCKET`     | Private Storage bucket name                                | No       | No      | default `stack-snapshots`     |
| `STACK_MAX_SNAPSHOT_BYTES`  | Max accepted snapshot archive size                         | No       | No      | default `209715200` (200 MiB) |

The service role key and ticket secret must never reach the browser, the CLI,
logs, or API responses. The server reads required variables via a fail-fast
helper, so a missing secret produces a clear startup error rather than an
insecure default.

## Test-only

None. The automated suite requires no environment configuration, no live
Supabase, and no network.
