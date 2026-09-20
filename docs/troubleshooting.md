# Troubleshooting

Stack uses typed errors. Messages state what failed, what did and did not change,
and the safe next step. Below are common situations.

## Skills and scanning

- **Invalid `SKILL.md`** — a Skill missing `name`/`description` front matter is
  reported and skipped; scanning continues. Fix the front matter and re-scan.
- **Unknown provenance** — a Skill with no clean Git source is preserved as a
  private snapshot. It works locally but cannot be published (see below).

## Composition and agents

- **`stack run` says an agent is missing** — the CLI verifies the agent binary
  (`codex` / `agent`|`cursor-agent` / `claude`) before any mutation. Install the
  agent or check your PATH.
- **Unmanaged binding conflict** — a target Skill directory exists that Stack did
  not create and whose content differs. Stack will not overwrite it. Remove or
  reconcile it manually, then re-run.
- **Cursor visibility conflict** — the same Skill name exists with differing
  content across Cursor-visible roots. Stack blocks rather than guess; resolve
  the divergence.
- **Store corruption / hash mismatch** — a Store object failed verification.
  Stack refuses to use it and never silently "repairs". The affected content must
  be reacquired; unrelated commands remain usable.

## Publishing

- **"Cannot publish … Skills require private snapshots"** — public Stacks are
  reference-only. Only Skills backed by a clean, portable Git reference can be
  published. Commit and push the Skill to a portable remote first.
- **"source remote contains embedded credentials" / unsafe remote** — remove the
  credential from the remote URL; publish from a clean https/ssh remote.
- **Invalid slug** — pass `--slug <slug>` matching `[a-z0-9][a-z0-9-_]{0,62}`.
- **Public Stack conflict** — someone/another machine published a newer version;
  fetch and retry.

## Cloud

- **`Stack Cloud is not configured`** — set `STACK_API_URL`. Local commands do
  not need it.
- **`Not signed in` / session expired** — run `stack login` again.
- **Push conflict (remote newer / unsynced remote)** — pull the newer Environment
  before pushing; Stack never overwrites automatically.
- **Pull conflict (local changes / unsynced local)** — you have local changes
  that were never pushed; Stack will not replace them automatically.
- **Private Git restore failure** — the exact revision could not be reacquired
  (missing revision, permission denied, hash mismatch). `main` is left unchanged.
  Ensure your existing Git credentials (SSH agent / credential manager) grant
  access; Stack never collects or stores Git credentials.
- **Network errors** — the cloud client surfaces typed errors
  (`CloudUnavailable`, `401`, `409`, timeouts) and never retries non-idempotent
  operations blindly.

## Installation and platform

- **`npx stack` runs the wrong tool** — the npm name `stack` belongs to an
  unrelated project. Use the installation method in
  [getting-started.md](getting-started.md).
- **pnpm/corepack on Windows** — use the repository's pinned pnpm via
  `corepack enable`. If a dependency's native build is blocked, it is governed by
  `allowBuilds` in `pnpm-workspace.yaml`.
- **Windows symlink limitations** — recreating nested Skill symlinks may require
  Developer Mode or elevation; Stack reports a clear error rather than producing
  incorrect content.
